/**
 * Ingest Emitter — engine-side gRPC client for the fc-aggregation spine
 * (ingest.v1.SpineIngest/Ingest). ENGINE PLUMBING ONLY: plugins never see
 * this module — it is deliberately NOT part of EngineServices or the plugin
 * contract. The queue hands it a plugin-produced ExtractedData; it maps that
 * 1:1 onto the wire and emits.
 *
 * FIDELITY (hard contract, mirrors the proto's doctrine):
 *   - fields_json = JSON.stringify(fields): the JSON TEXT of one object;
 *     string tokens pass byte-exact, never folded through float64.
 *   - extractedAt is a RAW STRING passthrough — never parsed or reformatted
 *     (PG-valid-but-JS-unparseable spellings must flow verbatim).
 *   - warnings travel verbatim; optional source fields stay ABSENT when
 *     absent.
 *
 * TRANSPORT: createGrpcTransport is h2c-hardwired HTTP/2, matching the
 * spine server (node:http2 cleartext behind the mesh). Never swap this for
 * createConnectTransport with httpVersion '1.1' — the server speaks gRPC
 * over h2 only.
 *
 * RETRY (SUCCESS = the RPC resolved OK — never key success on
 * stats.inserted > 0; a post-commit retry legitimately returns all-deduped
 * counts, and identical re-ingest is idempotent so at-least-once retry is
 * safe):
 *   - UNAVAILABLE      -> bounded exponential backoff, 3 tries total
 *   - INVALID_ARGUMENT -> NEVER retried: a producer bug, logged loudly
 *   - INTERNAL         -> at most one delayed retry, logged loudly
 *   - anything else    -> no retry
 */
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineIngest,
  ExtractedDataSchema,
  type ExtractedData as WireExtractedData,
  type WriteStats,
} from '@figurecollecting/ingest-contract';
import type { ExtractedData } from '@figurecollecting/scraper-plugin-contract';
import { sanitizeForLog } from '../utils/security.js';

/** Default per-call deadline. The server has no deadline of its own. */
export const DEFAULT_INGEST_TIMEOUT_MS = 30_000;

/** Total tries (first call + retries) for UNAVAILABLE. */
const UNAVAILABLE_MAX_TRIES = 3;
/** Total tries for INTERNAL: the first call plus exactly one delayed retry. */
const INTERNAL_MAX_TRIES = 2;

export interface IngestEmitterOptions {
  /** Spine ingest server base URL, e.g. http://fc-aggregation:50051 */
  baseUrl: string;
  /** Per-call deadline in ms (default 30s). */
  timeoutMs?: number;
  /** Base delay for exponential backoff between retries (default 1s). */
  retryDelayMs?: number;
}

export class IngestEmitter {
  private readonly client: Client<typeof SpineIngest>;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: IngestEmitterOptions) {
    // h2c-hardwired HTTP/2 — matches the spine's node:http2 cleartext server.
    const transport = createGrpcTransport({ baseUrl: options.baseUrl });
    this.client = createClient(SpineIngest, transport);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  /**
   * Emit one extraction to the spine. Resolves with the server's WriteStats
   * accounting (any OK response is success); rejects with the final
   * ConnectError once the retry policy is exhausted.
   */
  async send(extracted: ExtractedData): Promise<WriteStats> {
    const message = toWire(extracted);
    const label = `${extracted.source.site}:${extracted.source.itemId}`;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.ingest(message, { timeoutMs: this.timeoutMs });
      } catch (error) {
        const connectError = ConnectError.from(error);
        if (!this.shouldRetry(connectError, attempt, label)) {
          throw connectError;
        }
        const delay = this.retryDelayMs * 2 ** (attempt - 1);
        console.warn(
          `[INGEST EMITTER] ${Code[connectError.code]} from spine for ${label} (attempt ${attempt}), retrying in ${delay}ms: ${sanitizeForLog(connectError.rawMessage)}`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private shouldRetry(error: ConnectError, attempt: number, label: string): boolean {
    switch (error.code) {
      case Code.Unavailable:
        if (attempt < UNAVAILABLE_MAX_TRIES) return true;
        console.error(
          `[INGEST EMITTER] Spine UNAVAILABLE for ${label} after ${attempt} tries, giving up: ${sanitizeForLog(error.rawMessage)}`
        );
        return false;
      case Code.Internal:
        if (attempt < INTERNAL_MAX_TRIES) {
          console.error(
            `[INGEST EMITTER] INTERNAL from spine for ${label} — server-side fault, retrying ONCE: ${sanitizeForLog(error.rawMessage)}`
          );
          return true;
        }
        console.error(
          `[INGEST EMITTER] INTERNAL from spine for ${label} persisted after retry, giving up: ${sanitizeForLog(error.rawMessage)}`
        );
        return false;
      case Code.InvalidArgument:
        console.error(
          `[INGEST EMITTER] INVALID_ARGUMENT from spine for ${label} — producer bug, NOT retrying: ${sanitizeForLog(error.rawMessage)}`
        );
        return false;
      default:
        console.error(
          `[INGEST EMITTER] ${Code[error.code]} from spine for ${label}, not retrying: ${sanitizeForLog(error.rawMessage)}`
        );
        return false;
    }
  }
}

/**
 * Build the emitter from INGEST_BASE_URL (naming mirrors BACKEND_URL /
 * WEBHOOK_BASE_URL). Unset or empty = the new ingest path is DISABLED and
 * the queue keeps its legacy behavior.
 */
export function createIngestEmitterFromEnv(env: NodeJS.ProcessEnv = process.env): IngestEmitter | null {
  const baseUrl = env.INGEST_BASE_URL;
  if (!baseUrl) return null;

  const timeoutMs = env.INGEST_TIMEOUT_MS ? Number(env.INGEST_TIMEOUT_MS) : undefined;
  return new IngestEmitter({
    baseUrl,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
}

/** Map plugin ExtractedData 1:1 onto the ingest wire (fidelity: see header). */
function toWire(extracted: ExtractedData): WireExtractedData {
  const { site, itemId, url, extractedAt, rulesetVersion } = extracted.source;
  return create(ExtractedDataSchema, {
    source: {
      site,
      itemId,
      // RAW STRING passthrough — never parse or reformat the token.
      extractedAt,
      ...(url !== undefined ? { url } : {}),
      ...(rulesetVersion !== undefined ? { rulesetVersion } : {}),
    },
    // The JSON TEXT of ONE JSON object — exact serialization of the field bag.
    fieldsJson: JSON.stringify(extracted.fields),
    warnings: [...extracted.warnings],
  });
}
