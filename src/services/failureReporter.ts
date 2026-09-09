/**
 * failureReporter — the engine-side Connect client for the spine's fetch-failure ledger
 * (ingest.v1.SpineIngest/ReportFetchFailure, contract 0.3.0).
 *
 * WHY: every fetch failure the engine sees today dies with the pod — a console.warn and an
 * in-memory counter. Nothing is re-drivable and nothing reaches the operator. One TERMINAL failure
 * reported here becomes one durable, classified, self-closing ledger row.
 *
 * WHAT IS REPORTED: only a TERMINAL outcome — the producer has stopped trying for this cycle. Never
 * once per internal retry (the queue silently re-queues), never for a fetch that was never attempted
 * (an unsupported store is a declared coverage gap, not a failure). The one deliberate exception is
 * a COOLDOWN SKIP, which IS reported (the operator asked to see hosts we are deliberately leaving
 * alone) — but once per cooldown window, not once per skipped item, because the ledger's `attempts`
 * drives the server-side backoff.
 *
 * BEST EFFORT, ALWAYS: report() never rejects and never throws. A ledger row is bookkeeping; losing
 * one must never change an item's outcome or take down a crawl pass. Failures are counted (and
 * surfaced on /health/detailed), not propagated.
 *
 * TRANSPORT + RETRY: deliberately identical to ingestEmitter's — Connect over plain HTTP/1.1 (what
 * Linkerd meshes natively on this hop), the same INGEST_BASE_URL, UNAVAILABLE ×3 / INTERNAL ×2 /
 * INVALID_ARGUMENT ×1. See ingestEmitter.ts's TRANSPORT note before changing either.
 */
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineIngest,
  FetchFailureSchema,
  FetchKind,
  FetchOrigin,
  FetchReasonClass as WireReasonClass,
  type FetchFailure as WireFetchFailure,
  type FetchFailureAck,
} from '@figurecollecting/ingest-contract';
import { sanitizeForLog } from '../utils/security.js';
import type { FetchReasonClass } from './failureClassifier.js';

/** WHAT was being fetched — decides the shape of the canonical target. */
export type FetchKindName = 'record' | 'listing' | 'search' | 'image';
/** WHICH component observed the failure. */
export type FetchOriginName = 'crawler' | 'initiator' | 'lookup' | 'ingest';

/** Default per-call deadline. A ledger write is small; it must never hold an item path open. */
export const DEFAULT_REPORT_TIMEOUT_MS = 10_000;
/** Total tries (first call + retries) for UNAVAILABLE. */
const UNAVAILABLE_MAX_TRIES = 3;
/** Total tries for INTERNAL: the first call plus exactly one delayed retry. */
const INTERNAL_MAX_TRIES = 2;
/** The server caps `message` at 1 KB (octet_length); trim to BYTES so the wire carries only what it keeps. */
const MAX_MESSAGE_BYTES = 1024;
/**
 * How long drain() waits for the reports still on the wire. Long enough for a normal round trip and
 * the UNAVAILABLE ladder's first sleep, short enough that a hung spine cannot hold a CronJob open.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
/**
 * How long a cooldown report suppresses the NEXT report for the same target when the producer gave
 * no usable hint. Matches challengeCooldown's own default window.
 */
const DEFAULT_COOLDOWN_SUPPRESS_MS = 30 * 60_000;

/** One terminal fetch failure, in the engine's own vocabulary. */
export interface FetchFailureReport {
  /** The store's siteId. REQUIRED — the ledger keys on (source, kind, target). */
  site: string;
  /** The store's native id, when the target has one (absent for listing/search). */
  itemId?: string;
  /**
   * The CANONICAL target (spec §1.1): a real store URL for record/image, or the environment-free
   * `fc:` form for listing/search — `fc:listing/<site>?axis=…&page=…`, `fc:search/<site>?q=…`.
   * A real fetched listing URL would be the SCRAPER's own address and would split one store's
   * failures across environments. REQUIRED.
   */
  target: string;
  kind: FetchKindName;
  origin: FetchOriginName;
  reasonClass: FetchReasonClass;
  /** The upstream status when the lane surfaced one. Absent is honest and common. */
  httpStatus?: number;
  /** Failure text: sanitized, credential-redacted and byte-trimmed here before it is persisted. */
  message?: string;
  /** The lane the failing attempt used: http | impersonate | browser | api. */
  transport?: string;
  /** The ruleset in force, for triage of a parse/ruleset row. */
  rulesetVersion?: string;
  /** WHEN the attempt failed, as a raw string token. Defaults to the reporter's clock. */
  failedAt?: string;
  /**
   * The earliest instant a retry makes sense (a cooldown's remaining window). The server takes the
   * LATER of this and its own backoff — a hint may delay a retry, never pull one forward.
   */
  nextRetryHint?: string;
}

/** The narrow client surface the reporter needs — the generated Connect client satisfies it. */
export interface FetchFailureClient {
  reportFetchFailure(message: WireFetchFailure, options?: { timeoutMs?: number }): Promise<FetchFailureAck>;
}

/** What every emit point is handed: fire-and-forget, never throws. */
export type ReportFetchFailure = (report: FetchFailureReport) => Promise<void>;

const KIND_WIRE: Record<FetchKindName, FetchKind> = {
  record: FetchKind.RECORD,
  listing: FetchKind.LISTING,
  search: FetchKind.SEARCH,
  image: FetchKind.IMAGE,
};

const ORIGIN_WIRE: Record<FetchOriginName, FetchOrigin> = {
  crawler: FetchOrigin.CRAWLER,
  initiator: FetchOrigin.INITIATOR,
  lookup: FetchOrigin.LOOKUP,
  ingest: FetchOrigin.INGEST,
};

const REASON_WIRE: Record<FetchReasonClass, WireReasonClass> = {
  challenge: WireReasonClass.CHALLENGE,
  cooldown: WireReasonClass.COOLDOWN,
  timeout: WireReasonClass.TIMEOUT,
  http_5xx: WireReasonClass.HTTP_5XX,
  http_429: WireReasonClass.HTTP_429,
  http_403: WireReasonClass.HTTP_403,
  network: WireReasonClass.NETWORK,
  gone_404: WireReasonClass.GONE_404,
  gone_410: WireReasonClass.GONE_410,
  redirect_home: WireReasonClass.REDIRECT_HOME,
  parse: WireReasonClass.PARSE,
  ruleset: WireReasonClass.RULESET,
  validation: WireReasonClass.VALIDATION,
  other: WireReasonClass.OTHER,
};

/**
 * Process-wide reporting counters, surfaced on /health/detailed. Module-level (not per instance) so
 * the endpoint reads one number no matter how many call sites hold a reporter.
 */
const stats = { enabled: false, reported: 0, failed: 0, suppressed: 0 };

export interface FetchFailureReportView {
  /** A reporter was built from the environment (INGEST_BASE_URL set, kill switch not thrown). */
  enabled: boolean;
  /** Ledger rows the spine acknowledged. */
  reported: number;
  /** Reports the spine never took — refused locally, or the retry policy was exhausted. */
  failed: number;
  /** Cooldown skips deliberately NOT re-reported inside an open window. */
  suppressed: number;
}

/** The counters, as a copy — a caller can never mutate the live state. */
export function fetchFailureReportView(): FetchFailureReportView {
  return { ...stats };
}

/** Reset the counters (tests only). */
export function resetFetchFailureReportStats(): void {
  stats.enabled = false;
  stats.reported = 0;
  stats.failed = 0;
  stats.suppressed = 0;
}

export interface FailureReporterOptions {
  /** Spine ingest server base URL, e.g. http://fc-aggregation:50051. Ignored when `client` is given. */
  baseUrl?: string;
  /** Pre-built client (tests / DI). */
  client?: FetchFailureClient;
  /** Per-call deadline in ms (default 10s). */
  timeoutMs?: number;
  /** Base delay for exponential backoff between retries (default 1s). */
  retryDelayMs?: number;
  /** Injectable clock (default Date.now) — the failedAt stamp and the cooldown window. */
  now?: () => number;
}

export class FailureReporter {
  private readonly client: FetchFailureClient;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  /** target key → epoch ms until which a further COOLDOWN report is suppressed. */
  private readonly cooldownUntil = new Map<string, number>();
  /**
   * Reports still on the wire. EVERY emit point is fire-and-forget, and both CronJob entrypoints
   * end with process.exit(0) the moment the pass resolves — which aborts an open socket. Without
   * this set the last report of every pass (and, in a pass that only skipped cooling hosts, EVERY
   * report) would die exactly as it did before this feature existed.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: FailureReporterOptions) {
    this.client =
      options.client ??
      createClient(SpineIngest, createConnectTransport({ baseUrl: options.baseUrl ?? '', httpVersion: '1.1' }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Report ONE terminal fetch failure. Resolves either way: a refused, dropped, or undeliverable
   * report is counted and logged, never thrown — the caller's own failure handling is untouched.
   */
  report(report: FetchFailureReport): Promise<void> {
    const settled = this.deliver(report);
    const tracked = settled.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  /**
   * Wait for every in-flight report to settle, bounded by `timeoutMs`. Call it at the seam where a
   * process is about to exit; it never rejects, and a report still unsettled at the deadline is
   * abandoned rather than allowed to hold the process open.
   */
  async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    const deadline = this.now() + Math.max(0, timeoutMs);
    // A loop, not one allSettled: a report may be fired while an earlier one is still draining.
    while (this.inFlight.size > 0) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining);
        timer.unref?.();
      });
      const outcome = await Promise.race([Promise.allSettled([...this.inFlight]).then(() => 'done' as const), expiry]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') break;
    }
    if (this.inFlight.size > 0) {
      console.warn(`[FAILURE LEDGER] ${this.inFlight.size} report(s) abandoned undelivered at the drain deadline`);
    }
  }

  private async deliver(report: FetchFailureReport): Promise<void> {
    try {
      // The spine would answer INVALID_ARGUMENT for either of these; refusing locally keeps a
      // producer bug out of the retry ladder and off the server's error budget.
      if (!report.site || !report.target) {
        stats.failed++;
        console.warn(
          `[FAILURE LEDGER] refusing an incomplete report (site='${sanitizeForLog(report.site)}' target='${sanitizeForLog(report.target)}') — not sent`,
        );
        return;
      }
      if (this.suppressedByCooldownWindow(report)) {
        stats.suppressed++;
        return;
      }
      await this.send(toWire(report, this.now()), `${report.site}:${report.kind}:${report.target}`);
      stats.reported++;
    } catch (error) {
      stats.failed++;
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`[FAILURE LEDGER] report dropped for ${sanitizeForLog(report.site)}: ${sanitizeForLog(text)}`);
    }
  }

  /**
   * A cooldown SKIP is one fact about a window, not one fact per skipped item: the host is cooling
   * until `nextRetryHint`, and every item for it will skip identically until then. Report the first,
   * suppress the rest of that window (keyed per target, so a second cooling item still gets its own
   * row). Without a usable hint, fall back to challengeCooldown's own default window.
   */
  private suppressedByCooldownWindow(report: FetchFailureReport): boolean {
    if (report.reasonClass !== 'cooldown') return false;
    const key = `${report.site}\u001f${report.kind}\u001f${report.target}`;
    const now = this.now();
    const until = this.cooldownUntil.get(key);
    if (until !== undefined && until > now) return true;

    const hinted = report.nextRetryHint ? Date.parse(report.nextRetryHint) : Number.NaN;
    // Sweep first: the key is per (site, kind, TARGET), so a long cooldown over a busy store leaves
    // one entry per item url. Without this the map only ever grows, and it grows fastest exactly
    // when the host is unhealthy — in a server process that lives for days.
    for (const [k, expiry] of this.cooldownUntil) {
      if (expiry <= now) this.cooldownUntil.delete(k);
    }
    this.cooldownUntil.set(key, Number.isFinite(hinted) && hinted > now ? hinted : now + DEFAULT_COOLDOWN_SUPPRESS_MS);
    return false;
  }

  private async send(message: WireFetchFailure, label: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.reportFetchFailure(message, { timeoutMs: this.timeoutMs });
        return;
      } catch (error) {
        const connectError = ConnectError.from(error);
        if (!this.shouldRetry(connectError, attempt, label)) throw connectError;
        const delay = this.retryDelayMs * 2 ** (attempt - 1);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private shouldRetry(error: ConnectError, attempt: number, label: string): boolean {
    switch (error.code) {
      case Code.Unavailable:
        return attempt < UNAVAILABLE_MAX_TRIES;
      case Code.Internal:
        return attempt < INTERNAL_MAX_TRIES;
      case Code.InvalidArgument:
        // A producer bug: the same message would be refused the same way. Loud, never retried.
        console.error(
          `[FAILURE LEDGER] INVALID_ARGUMENT from spine for ${sanitizeForLog(label)} — producer bug, NOT retrying: ${sanitizeForLog(error.rawMessage)}`,
        );
        return false;
      default:
        return false;
    }
  }
}

/**
 * Build the reporter from the environment. Reporting rides the SAME INGEST_BASE_URL as the ingest
 * emitter (one spine, one hop) and is ON by default; REPORT_FETCH_FAILURES is the kill switch.
 * Null = reporting is OFF and every call site is a no-op — exactly how the ingest path degrades when
 * INGEST_BASE_URL is unset.
 */
export function createFailureReporterFromEnv(env: NodeJS.ProcessEnv = process.env): FailureReporter | null {
  const baseUrl = env.INGEST_BASE_URL;
  if (!baseUrl || !reportingEnabled(env.REPORT_FETCH_FAILURES)) {
    stats.enabled = false;
    return null;
  }

  const timeoutMs = env.REPORT_FAILURE_TIMEOUT_MS ? Number(env.REPORT_FAILURE_TIMEOUT_MS) : undefined;
  stats.enabled = true;
  return new FailureReporter({
    baseUrl,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
}

/**
 * The kill switch reads as ON unless it is explicitly turned off. Unset, empty, and whitespace all
 * mean "not configured", which must never silently disable the ledger.
 */
function reportingEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === '') return true;
  return !(value === 'false' || value === '0' || value === 'no' || value === 'off');
}

/**
 * Strip credentials a transport fault may have embedded in its text. sanitizeForLog defends the LOG
 * (newlines, ANSI, control chars); this defends the LEDGER, which is durable and read by an
 * operator. The impersonate lane accepts a credentialed proxy, so `scheme://user:pass@host` is a
 * shape that genuinely reaches here — /health/detailed already redacts the same value.
 */
function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, '$1<redacted>@')
    .replace(/\b(authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*\S+/gi, '$1: <redacted>');
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 BYTES, never mid code point. The server's CHECK is
 * octet_length(message) <= 1024, and a Japanese store error surfaced through JSON.parse is ~3 bytes
 * per character — slicing code units would send three times what the row can hold.
 */
function trimToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off over any UTF-8 continuation byte (0b10xxxxxx) so the cut lands on a boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/** Sanitize, redact + hard-trim the failure text. The server caps at 1 KB; never send more. */
function trimMessage(message: string | undefined): string {
  if (!message) return '';
  return trimToBytes(redactCredentials(sanitizeForLog(message)), MAX_MESSAGE_BYTES);
}

/** Map one engine report onto the contract message. Optional fields stay ABSENT when absent. */
function toWire(report: FetchFailureReport, nowMs: number): WireFetchFailure {
  return create(FetchFailureSchema, {
    source: {
      site: report.site,
      // The proto's contract: an EMPTY item_id means "no native id" (listing/search) -> NULL.
      itemId: report.itemId ?? '',
      url: report.target,
      // RAW STRING passthrough, same never-parse doctrine as the ingest path.
      extractedAt: report.failedAt ?? new Date(nowMs).toISOString(),
      ...(report.rulesetVersion !== undefined ? { rulesetVersion: report.rulesetVersion } : {}),
    },
    kind: KIND_WIRE[report.kind],
    reasonClass: REASON_WIRE[report.reasonClass],
    origin: ORIGIN_WIRE[report.origin],
    message: trimMessage(report.message),
    ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
    ...(report.transport !== undefined ? { transport: report.transport } : {}),
    ...(report.nextRetryHint !== undefined ? { nextRetryHint: report.nextRetryHint } : {}),
  });
}
