// ============================================================================
// telemetry.ts — the scraper's ONE seam onto fc-shared's node-only server
// subpaths (fc-shared 1.8.0), for the batch jobs: ingest-crawler (and
// ingest-seed-mfc, the same entry), ingest-initiator and gallery-capture.
// The HTTP server never loads this file: its own tracing is src/tracing.ts,
// which takes only fc-shared's propagation allowlist, and its queue carries
// item traces with the server/job traceparent pair (services/queueTrace.ts).
//
//   createServiceLogger   server/log createLogger: one JSON object per stdout
//                         line in the estate's shape, every value through
//                         fc-shared redaction plus the scraper's own store-
//                         session shapes (cookie headers, cf_clearance and the
//                         other session cookies, secret-named key=value pairs,
//                         userinfo written without a scheme).
//   startServiceTracing   server/tracing startTracing with NO exporter: spans
//                         record with real ids so every line carries trace_id,
//                         and nothing leaves the process. Export is the parked
//                         log-store unit's to switch on (OTEL_EXPORTER_OTLP_*),
//                         not this file's.
//   runJobProcess         one CronJob/Job run: tracing, the job logger as the
//                         process's (the legacy utils/logger lines, stray
//                         console calls, the ingest-server rpc.out lines all go
//                         through it), and runCountedJob: one root trace, one
//                         job.start line, one job.end line with the run's counts.
//   itemTracer            ONE TRACE PER ITEM (Ross's choice, fc-shared run.item):
//                         a unit of the run's work is a NEW root trace linked to
//                         the run (span link + fc.run_id), so its lines and its
//                         in-cluster calls carry the item's ids, not the run's.
//                         A log line has no run id field (fc-shared 1.8.0 writes
//                         trace_id/span_id only): an item's line reaches its run
//                         through the item span's fc.run_id.
//   traceHeaders,         the active span's W3C traceparent for a fetch to an
//   tracedFetch           in-cluster host (the propagation allowlist decides);
//                         a store or any other host gets none.
// ============================================================================
import { context, propagation } from '@opentelemetry/api';
import { rpcClientInterceptor } from '@figurecollecting/fc-shared/server/connect';
import { runJob, type JobRun } from '@figurecollecting/fc-shared/server/job';
import { RESERVED_LOG_KEYS, createLogger, installConsoleBridge, toSnakeCase, type Logger } from '@figurecollecting/fc-shared/server/log';
import { startTracing, withPropagationTarget, type Tracing } from '@figurecollecting/fc-shared/server/tracing';
import { DEFAULT_SECRET_VALUE_PATTERNS, type RedactOptions } from '@figurecollecting/fc-shared/utils/sanitize';
import { installOutboundRpcInterceptors } from './services/outboundRpc.js';
import { logger as legacyLogger } from './utils/logger.js';

export type { JobRun, Logger, Tracing };

type Env = Record<string, string | undefined>;
type Fields = Record<string, unknown>;

/** The ingest-crawler CronJob (src/crawler/run.ts); ingest-seed-mfc runs the same entry with CRAWLER_MODE=seed. */
export const INGEST_CRAWLER = 'ingest-crawler';
/** The ingest-initiator CronJob (src/initiator/run.ts). */
export const INGEST_INITIATOR = 'ingest-initiator';
/** The gallery-capture Job (src/services/images/galleryCaptureCli.ts). */
export const GALLERY_CAPTURE = 'gallery-capture';

/** OTEL_SERVICE_NAME when the deployment sets one, else the job's own name. */
export function serviceName(fallback: string, env: Env = process.env): string {
  return env['OTEL_SERVICE_NAME']?.trim() || fallback;
}

/**
 * Store-session secrets in the shapes they reach a job's lines as PROSE (an error message, an echoed
 * response body), where fc-shared's key- and URL-based rules do not see them. Each match is masked whole.
 */
export const SCRAPER_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // a Cookie or Set-Cookie header anywhere in the text, to the end of its line
  /\b(?:set-)?cookie\s*:\s*[^\r\n]+/gi,
  // a store session cookie written out as name=value (Cloudflare's clearance and bot cookies, PHP and remember-me sessions, 2FA
  // trust). Not inside a URL's query: fc-shared drops the whole query, and masking first would leave the placeholder's bracket behind.
  /(?<![?&#\w-])(?:cf_clearance|__cf_bm|__cfruid|_cfuvid|cf_chl_[a-z0-9_]*|phpsessid|tfatrust|remember[a-z0-9_]*)=[^;\s,"'&]+/gi,
  // any other secret-named key=value pair outside a URL's query (token=..., api_key=..., session_id=...)
  /(?<![?&#\w-])[\w-]*(?:token|secret|passw(?:or)?d|api[-_]?key|access[-_]?key|signature|session[-_]?id)=[^\s&;,"']+/gi,
  // userinfo written without a scheme (user:pass@proxy:port); a URL's own userinfo is stripped by fc-shared. Bounded, so a
  // long run of punctuation costs linear time.
  /(?<![\w/:.@-])[^\s:@/]{1,64}:[^\s:@/]{1,256}@(?=[a-z0-9.-])/gi,
];

const SCRAPER_REDACTION: RedactOptions = { secretValuePatterns: [...DEFAULT_SECRET_VALUE_PATTERNS, ...SCRAPER_SECRET_VALUE_PATTERNS] };

export interface ServiceLoggerOptions {
  env?: Env;
  /** Where a finished line goes. Default: one line on stdout. */
  sink?: (line: string) => void;
}

export function createServiceLogger(service: string, options: ServiceLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  return createLogger({ service: serviceName(service, env), env, redact: SCRAPER_REDACTION, ...(options.sink === undefined ? {} : { sink: options.sink }) });
}

/** Tracing for this process, export off: OTLP endpoint variables are never read here. */
export function startServiceTracing(service: string, env: Env = process.env): Tracing {
  const { OTEL_EXPORTER_OTLP_ENDPOINT: _all, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: _traces, ...rest } = env;
  return startTracing(serviceName(service, env), { env: rest });
}

// ---------------------------------------------------------------------------
// The legacy logger (src/utils/logger.ts), routed into the job logger.
// ---------------------------------------------------------------------------

/** The legacy logger's `[TAG] text` prefix, read as fc-shared's console bridge reads it. */
const LEADING_TAG = /^\[([A-Za-z][^[\]\r\n]{0,63})\]\s*/;
/**
 * Keys a legacy line's data may not take: the shape's own (a caller value for one is dropped or typed, so
 * `version` would vanish and `code` print as a placeholder) and this adapter's. duration_ms is the one
 * reserved key whose meaning a pass's own durationMs shares, so it stays.
 */
const TAKEN = new Set<string>([...RESERVED_LOG_KEYS.filter(key => key !== 'duration_ms'), 'tag', 'namespace']);

/**
 * One legacy call as the (fields, msg) the job logger prints: the `[TAG]` prefix becomes `tag`, plain
 * data becomes fields (a key the shape owns is kept as data_<key>), an Error becomes err, any other value
 * `data`, and empty data nothing, as the legacy logger printed nothing for it.
 */
export function legacyLine(message: string, data?: unknown, namespace?: string): [Fields, string] {
  const fields: Fields = {};
  if (data instanceof Error) fields['err'] = data;
  else if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) fields[TAKEN.has(toSnakeCase(key)) ? `data_${key}` : key] = value;
  } else if (data) fields['data'] = data;
  if (namespace !== undefined) fields['namespace'] = namespace;
  const tag = LEADING_TAG.exec(message);
  if (tag === null) return [fields, message];
  fields['tag'] = tag[1]!.trim();
  return [fields, message.slice(tag[0].length)];
}

/** Send the legacy logger's lines through `target`; returns the undo. */
export function routeLegacyLogger(target: Logger): () => void {
  const previous = legacyLogger.route((level, message, data, namespace) => {
    const [fields, msg] = legacyLine(message, data, namespace);
    target[level](fields, msg);
  });
  return () => {
    legacyLogger.route(previous);
  };
}

// ---------------------------------------------------------------------------
// Outgoing calls.
// ---------------------------------------------------------------------------

/**
 * `headers` plus the active span's W3C traceparent when `url` is an in-cluster host
 * (OTEL_PROPAGATION_ALLOWLIST, default *.svc.cluster.local, *.svc, localhost). Any other host, or no
 * tracing, gets the headers unchanged: a store never sees our trace ids.
 */
export function traceHeaders(url: string, headers: Record<string, string> = {}): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };
  propagation.inject(withPropagationTarget(context.active(), url), carrier);
  return carrier;
}

/** The request options a job's fetch takes: RequestInit with its headers as a plain record. */
export type JobRequestInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/** `fetchImpl` with traceHeaders on every request: the shape of the crawler's and the initiator's FetchLike. */
export function tracedFetch(fetchImpl: typeof fetch): (url: string, init?: JobRequestInit) => Promise<Response> {
  return (url, init) => fetchImpl(url, { ...init, headers: traceHeaders(url, init?.headers) });
}

// ---------------------------------------------------------------------------
// One trace per item.
// ---------------------------------------------------------------------------

/**
 * Run `fn`, one unit of a pass's work for store `site`, as its own trace. What a pass's deps take (the crawler's and
 * the initiator's enqueue, the gallery's item); absent, the pass runs the unit inline, in the caller's trace.
 */
export type TraceItem = <T>(site: string, fn: () => Promise<T>) => Promise<T>;

/**
 * fc-shared run.item as a TraceItem: each call is a NEW root span (`name`, default fc-shared's item.enqueue; kind
 * PRODUCER) linked to the run, with fc.run_id and fc.site. Lines written and in-cluster requests made inside it carry
 * the item's trace; a failed item is an error span and its error is rethrown unchanged for the pass to handle.
 */
export function itemTracer(run: JobRun, name?: string): TraceItem {
  return (site, fn) => run.item(fn, { ...(name === undefined ? {} : { name }), attributes: { 'fc.site': site } });
}

// ---------------------------------------------------------------------------
// One start line and one end line per run.
// ---------------------------------------------------------------------------

/**
 * `logger`, with `extra()` merged under the fields of its info and error calls (the call's own win).
 * Those are the only two runJob makes, job.start and job.end, each as (fields, msg).
 */
function withExtraFields(logger: Logger, extra: () => Fields | undefined): Logger {
  const merged = (level: 'info' | 'error') =>
    (first: unknown, ...rest: unknown[]): void => {
      const more = extra();
      if (more === undefined) logger[level](first, ...rest);
      else logger[level]({ ...more, ...(first as Fields) }, ...rest);
    };
  return { ...logger, info: merged('info'), error: merged('error') };
}

export interface CountedJobOptions {
  logger: Logger;
  env?: Env;
}

/**
 * runJob, with `counts(result)` written on the job.end line. A failed run has no result: its end line
 * carries code=error and err instead, and the error is rethrown unchanged. runJob writes job.start and
 * job.end itself, both as (fields, msg), which is all withExtraFields has to merge into.
 */
export async function runCountedJob<T>(
  name: string,
  fn: (run: JobRun) => Promise<T>,
  counts: (result: T) => Fields,
  options: CountedJobOptions,
): Promise<T> {
  let fields: Fields | undefined;
  const logger = withExtraFields(options.logger, () => fields);
  return runJob(name, async run => {
    const result = await fn(run);
    fields = counts(result);
    return result;
  }, { logger, env: options.env });
}

export interface JobProcessOptions {
  /** Default process.env. */
  env?: Env;
  /** Default: the job's logger on stdout. */
  logger?: Logger;
}

/**
 * The whole of one CronJob/Job run. Tracing starts (a run whose tracing cannot start still runs, and
 * says so once); for the run, the legacy logger, stray console calls and the ingest-server Connect
 * calls (rpc.out, with the active run's or item's traceparent) all write through the job logger;
 * runCountedJob brackets `fn` with job.start and job.end, and hands it the run to open items on
 * (itemTracer). Everything is put back before it returns or rethrows.
 */
export async function runJobProcess<T>(
  service: string,
  fn: (logger: Logger, run: JobRun) => Promise<T>,
  counts: (result: T) => Fields,
  options: JobProcessOptions = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createServiceLogger(service, { env });
  // Trace ids are worth a lot to an operator and nothing to the pass: a run whose tracing
  // cannot start still runs, and says so.
  let tracing: Tracing | undefined;
  try {
    tracing = startServiceTracing(service, env);
  } catch (err) {
    logger.warn({ event: 'tracing.unavailable', err }, 'tracing did not start; this run goes on without trace ids');
  }
  const restoreLegacy = routeLegacyLogger(logger);
  const restoreConsole = installConsoleBridge(logger);
  const restoreRpc = installOutboundRpcInterceptors([rpcClientInterceptor({ logger })]);
  try {
    return await runCountedJob(service, run => fn(logger, run), counts, { logger, env });
  } finally {
    restoreRpc();
    restoreConsole();
    restoreLegacy();
    await tracing?.shutdown();
  }
}
