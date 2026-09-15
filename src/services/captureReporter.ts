/**
 * captureReporter — the engine-side Connect client for the spine's stored-object provenance ledger
 * (ingest.v1.SpineIngest/ReportCapture, contract 0.6.0).
 *
 * WHY: the sink writes ORIGINAL bytes to the content-addressed bucket, but nothing tells the spine
 * that the object is at rest. Without a row, the derivative pipeline can never find those bytes, and
 * a second item sharing an image never gets a depiction at all — the object's own metadata names only
 * the FIRST item that referenced it. ReportCapture turns each stored object into one durable
 * `raw.capture` row (and, when the report names an item, one `product_image` depiction).
 *
 * BEST EFFORT, ALWAYS: report() never rejects and never throws. A dropped report is a missing row for
 * bytes that ARE in the bucket, repaired by the backfill (I5) — never a change to a scrape's outcome.
 * Failures are counted (surfaced on /health/detailed) and logged at most once per host per hour.
 *
 * OFF BY DEFAULT: REPORT_CAPTURES must be explicitly on. Unlike the failure ledger (on unless killed),
 * this ships DARK — nothing reports until an operator arms it — because the server handler lands in a
 * separate deploy (I2) and the reporter is meant to be shippable ahead of it.
 *
 * UNIMPLEMENTED SELF-DISABLES: a reporter that meets UNIMPLEMENTED disables itself for the process,
 * says so once, and counts the drop. That is exactly the ship-before-server case, and it must not
 * hammer a spine that has no handler yet.
 *
 * ENGINE_VERSION IS ABSENT ON LANE 'asset': the server supplies the constant `'object-store'`, so a
 * producer value there is a structural fault (INVALID_ARGUMENT, whole batch). The reporter drops the
 * field on that lane rather than let a caller bug reach the wire — NULL was never an option (the
 * column is NOT NULL).
 *
 * TRANSPORT + RETRY: deliberately identical to failureReporter's — Connect over plain HTTP/1.1 (what
 * Linkerd meshes natively on this hop), the same INGEST_BASE_URL, UNAVAILABLE ×3 / INTERNAL ×2 /
 * INVALID_ARGUMENT ×1. See failureReporter.ts's TRANSPORT note before changing either.
 */
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineIngest,
  StoredCaptureSchema,
  CaptureBatchSchema,
  type CaptureBatch as WireCaptureBatch,
  type CaptureAck,
} from '@figurecollecting/ingest-contract';
import type { CaptureLane } from './captureSink.js';
import { sanitizeForLog } from '../utils/security.js';

/** Default per-call deadline. A ledger write is small; it must never hold a capture path open. */
export const DEFAULT_REPORT_TIMEOUT_MS = 10_000;
/** Total tries (first call + retries) for UNAVAILABLE. */
const UNAVAILABLE_MAX_TRIES = 3;
/** Total tries for INTERNAL: the first call plus exactly one delayed retry. */
const INTERNAL_MAX_TRIES = 2;
/** A content address is EXACTLY 32 bytes; on the wire we carry it as raw bytes, here as 64 hex chars. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;
/**
 * One log line per host per hour, whatever the volume. A spine that starts refusing reports refuses
 * them for every image of every host at once; the counters carry the real volume losslessly.
 */
const HOST_LOG_INTERVAL_MS = 60 * 60_000;

/**
 * One stored object, in the engine's own vocabulary. Mirrors the sink's RawCapture provenance plus the
 * two facts only the sink knows: the object key it PUT and the uncompressed length.
 */
export interface StoredCaptureReport {
  /** The store's siteId. REQUIRED — a capture with no store has no source to attribute. */
  site: string;
  /** The store's native id, when the capture names an item (the depiction key). Absent ⇒ a PAGE capture. */
  itemId?: string;
  /** The address the bytes were fetched from. REQUIRED — raw.url keys on it. */
  url: string;
  /** The capture lane. 'asset' is the image lane and the only one carrying depiction fields. */
  lane: CaptureLane;
  /** Lowercase hex sha256 of the UNCOMPRESSED bytes — the content address. REQUIRED, exactly 64 hex. */
  sha256: string;
  /** Uncompressed length in bytes. */
  bytesLen: number;
  /** The object key actually written under `sha256-v1`. REQUIRED, non-empty (an empty key is refused). */
  storageKey: string;
  /**
   * WHEN the fetch was observed, as a raw string token. It is PART OF THE CAPTURE KEY, so a memo-hit
   * or in-flight loser MUST re-send the WINNER's token to dedup into one row rather than fork a second
   * observation. Defaults to the reporter's clock only for a genuinely fresh fetch.
   */
  fetchedAt?: string;
  rulesetVersion?: string;
  contentType?: string;
  /** The address the fetch finally landed on, when redirects moved it. */
  finalUrl?: string;
  httpStatus?: number;
  /**
   * MUST BE ABSENT on lane 'asset' (the server supplies the constant). Dropped there by toWire even if
   * a caller sets it, because a value on that lane is INVALID_ARGUMENT at the shell.
   */
  engineVersion?: string;
  /** Depiction role: 'gallery' | 'other' | … (asset lane). */
  role?: string;
  /** 0-based position in the referencing page's gallery. Present-0 and absent are different facts. */
  position?: number;
  /** The item PAGE that referenced the bytes, when it differs from the fetch address. */
  sourceUrl?: string;
  contentEncoding?: string;
  vary?: string;
  /** TRUE when the object was already at rest before this observation (HEAD hit, in-flight loser, memo hit). */
  alreadyStored: boolean;
  sourceClass?: string;
  contentLevel?: string;
}

/** The narrow client surface the reporter needs — the generated Connect client satisfies it. */
export interface CaptureClient {
  reportCapture(message: WireCaptureBatch, options?: { timeoutMs?: number }): Promise<CaptureAck>;
}

/** What every emit point is handed: fire-and-forget, never throws. */
export type ReportStoredCapture = (report: StoredCaptureReport) => Promise<void>;

/**
 * Process-wide reporting state, surfaced on /health/detailed. Module-level (not per instance) so the
 * endpoint reads one number, and so the UNIMPLEMENTED self-disable and the per-host log clock are
 * process facts no matter how many call sites hold a reporter (the sink and the hook each hold one).
 */
const stats = { enabled: false, reported: 0, failed: 0, disabled: false };
/** host → epoch ms of the last drop line logged for it. */
const lastLoggedByHost = new Map<string, number>();

export interface CaptureReportView {
  /** A reporter was built from the environment (INGEST_BASE_URL set AND REPORT_CAPTURES on). */
  enabled: boolean;
  /** Captures the spine acknowledged. */
  reported: number;
  /** Reports the spine never took — refused locally, retry exhausted, or dropped while disabled. */
  failed: number;
  /** The spine answered UNIMPLEMENTED and reporting is off for the rest of the process. */
  disabled: boolean;
}

/** The counters, as a copy — a caller can never mutate the live state. */
export function captureReportView(): CaptureReportView {
  return { ...stats };
}

/** Reset the counters and the process self-disable (tests only). */
export function resetCaptureReportStats(): void {
  stats.enabled = false;
  stats.reported = 0;
  stats.failed = 0;
  stats.disabled = false;
  lastLoggedByHost.clear();
}

export interface CaptureReporterOptions {
  /** Spine ingest server base URL, e.g. http://fc-aggregation:50051. Ignored when `client` is given. */
  baseUrl?: string;
  /** Pre-built client (tests / DI). */
  client?: CaptureClient;
  /** Per-call deadline in ms (default 10s). */
  timeoutMs?: number;
  /** Base delay for exponential backoff between retries (default 1s). */
  retryDelayMs?: number;
  /** Injectable clock (default Date.now) — the extractedAt fallback and the per-host log window. */
  now?: () => number;
  /** Injectable logger (default console.warn) — the rate-limited drop line and the disable notice. */
  warn?: (message: string) => void;
}

export class CaptureReporter {
  private readonly client: CaptureClient;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(options: CaptureReporterOptions) {
    this.client =
      options.client ??
      createClient(SpineIngest, createConnectTransport({ baseUrl: options.baseUrl ?? '', httpVersion: '1.1' }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.now = options.now ?? Date.now;
    // eslint-disable-next-line no-console
    this.warn = options.warn ?? ((message: string) => console.warn(message));
  }

  /**
   * Report ONE stored object. Resolves either way: a refused, dropped, or undeliverable report is
   * counted (and logged at most once per host per hour), never thrown — the capture path is untouched.
   */
  report(report: StoredCaptureReport): Promise<void> {
    return this.deliver(report);
  }

  private async deliver(report: StoredCaptureReport): Promise<void> {
    // The spine returned UNIMPLEMENTED earlier — reporting is off for this process. Count the drop so
    // the shortfall is visible, but say nothing more (the disable was already logged once).
    if (stats.disabled) {
      stats.failed++;
      return;
    }
    const host = hostOf(report.url);
    if (!this.structurallyValid(report, host)) return; // counts + logs the refusal itself
    try {
      await this.send(toWire(report, this.now()), host);
      stats.reported++;
    } catch (error) {
      stats.failed++;
      // INVALID_ARGUMENT is logged loudly in shouldRetry; UNIMPLEMENTED logged once at the disable.
      // Everything else is a transient drop — one line per host per hour, the volume in the counter.
      const code = ConnectError.from(error).code;
      if (code !== Code.InvalidArgument && code !== Code.Unimplemented) {
        const text = error instanceof Error ? error.message : String(error);
        this.logOncePerHost(host, `[CAPTURE LEDGER] report dropped for ${sanitizeForLog(report.site)} (${sanitizeForLog(host)}): ${sanitizeForLog(text)}`);
      }
    }
  }

  /**
   * Refuse locally exactly what the shell would answer INVALID_ARGUMENT for — an empty site, url or
   * storage_key, or a sha that is not 32 bytes — so a producer bug stays off the retry ladder and off
   * the server's error budget. Counted as a failure and logged once per host.
   */
  private structurallyValid(report: StoredCaptureReport, host: string): boolean {
    const refuse = (why: string): boolean => {
      stats.failed++;
      this.logOncePerHost(host, `[CAPTURE LEDGER] refusing an incomplete report (${why}) — not sent`);
      return false;
    };
    if (!report.site) return refuse('no site');
    if (!report.url) return refuse('no url');
    if (!report.storageKey) return refuse('no storage_key — a capture with no key is not a stored capture');
    if (!SHA256_HEX.test(report.sha256)) return refuse('blob sha256 is not 32 bytes (64 hex)');
    return true;
  }

  private async send(batch: WireCaptureBatch, host: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.reportCapture(batch, { timeoutMs: this.timeoutMs });
        return;
      } catch (error) {
        const connectError = ConnectError.from(error);
        if (connectError.code === Code.Unimplemented) {
          // Ship-before-server: stop trying for the process, say so once, and let deliver count it.
          if (!stats.disabled) {
            stats.disabled = true;
            this.warn(`[CAPTURE LEDGER] ReportCapture is UNIMPLEMENTED on the spine — capture reporting disabled for this process (arm it after the server handler ships)`);
          }
          throw connectError;
        }
        if (!this.shouldRetry(connectError, attempt, host)) throw connectError;
        const delay = this.retryDelayMs * 2 ** (attempt - 1);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private shouldRetry(error: ConnectError, attempt: number, host: string): boolean {
    switch (error.code) {
      case Code.Unavailable:
        return attempt < UNAVAILABLE_MAX_TRIES;
      case Code.Internal:
        return attempt < INTERNAL_MAX_TRIES;
      case Code.InvalidArgument:
        // A producer bug: the same batch would be refused the same way. Loud, never retried.
        // eslint-disable-next-line no-console
        console.error(
          `[CAPTURE LEDGER] INVALID_ARGUMENT from spine for ${sanitizeForLog(host)} — producer bug, NOT retrying: ${sanitizeForLog(error.rawMessage)}`,
        );
        return false;
      default:
        return false;
    }
  }

  private logOncePerHost(host: string, message: string): void {
    const last = lastLoggedByHost.get(host);
    const at = this.now();
    if (last !== undefined && at - last < HOST_LOG_INTERVAL_MS) return;
    lastLoggedByHost.set(host, at);
    this.warn(message);
  }
}

/** Best-effort host for the per-host log key. Empty when the url does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Map one engine report onto a one-capture batch. Optional fields stay ABSENT when absent, and
 * engine_version is dropped on lane 'asset' whatever the caller passed.
 */
function toWire(report: StoredCaptureReport, nowMs: number): WireCaptureBatch {
  const capture = create(StoredCaptureSchema, {
    source: {
      site: report.site,
      // The proto's contract: an EMPTY item_id means "no native id" (a PAGE capture) -> NULL.
      itemId: report.itemId ?? '',
      url: report.url,
      // RAW STRING passthrough, same never-parse doctrine as the ingest path; it is in the capture key.
      extractedAt: report.fetchedAt ?? new Date(nowMs).toISOString(),
      ...(report.rulesetVersion !== undefined ? { rulesetVersion: report.rulesetVersion } : {}),
    },
    lane: report.lane,
    // hex -> 32 raw bytes: hex would make case and an 0x prefix into wire variants of one value.
    blobSha256: Buffer.from(report.sha256, 'hex'),
    bytesLen: BigInt(Math.max(0, Math.trunc(report.bytesLen))),
    storageKey: report.storageKey,
    alreadyStored: report.alreadyStored,
    ...(report.contentType !== undefined ? { contentType: report.contentType } : {}),
    ...(report.finalUrl !== undefined ? { finalUrl: report.finalUrl } : {}),
    ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
    // Field 9 MUST BE ABSENT on lane 'asset'. Off-asset it may carry the engine's version.
    ...(report.lane !== 'asset' && report.engineVersion !== undefined ? { engineVersion: report.engineVersion } : {}),
    ...(report.role !== undefined ? { role: report.role } : {}),
    ...(report.position !== undefined ? { position: report.position } : {}),
    ...(report.sourceUrl !== undefined ? { sourceUrl: report.sourceUrl } : {}),
    ...(report.contentEncoding !== undefined ? { contentEncoding: report.contentEncoding } : {}),
    ...(report.vary !== undefined ? { vary: report.vary } : {}),
    ...(report.sourceClass !== undefined ? { sourceClass: report.sourceClass } : {}),
    ...(report.contentLevel !== undefined ? { contentLevel: report.contentLevel } : {}),
  });
  return create(CaptureBatchSchema, { captures: [capture] });
}

/**
 * Build the reporter from the environment. Reporting rides the SAME INGEST_BASE_URL as the ingest
 * emitter (one spine, one hop) and is OFF unless REPORT_CAPTURES is explicitly on — the feature ships
 * dark and is armed deliberately, because the server handler lands in a separate deploy. Null = every
 * call site is a no-op.
 */
export function createCaptureReporterFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureReporter | null {
  const baseUrl = env.INGEST_BASE_URL;
  if (!baseUrl || !reportingEnabled(env.REPORT_CAPTURES)) {
    stats.enabled = false;
    return null;
  }
  const timeoutMs = env.REPORT_CAPTURE_TIMEOUT_MS ? Number(env.REPORT_CAPTURE_TIMEOUT_MS) : undefined;
  stats.enabled = true;
  return new CaptureReporter({
    baseUrl,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
}

/**
 * OFF unless explicitly on — the inverse of the failure ledger's switch. Unset, empty and every
 * negative spelling mean "not armed"; only an affirmative value turns capture reporting on.
 */
function reportingEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}
