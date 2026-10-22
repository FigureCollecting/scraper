/**
 * galleryCapture — the `gallery:capture` Job's body (MFC-GALLERY-2; docs/mfc-gallery-2.md).
 *
 * Composes the gallery driver from the pieces the ingest image lane already uses: the same capture hook (the same
 * sink and spine reporter built from the same env), the same host policy table, the same per-host pacing wrapper with
 * the limiter's rate taken from IMAGE_HOST_RATE_JSON, and a plain-http-only bytes router — so any other lane is
 * `unsupported` by construction, not by configuration. Nothing here fetches an image itself.
 *
 * Exit codes (one meaning each): 0 done (or a limit reached), 1 the run crashed, 2 bad arguments, input or config (nothing ran),
 * 3 paused (a block, a failure storm, or a live pause marker), 4 refused (lane off or the host policy is not plain http + direct),
 * 5 probe not a PASS (a probe exits by its printed verdict: 0 or 5), 6 the raw store did not confirm some item's files (unsettled, run again), 7 stopped by SIGTERM/SIGINT or by
 * losing the lock, 8 LOCKED (another run holds the lease; this one made no request).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SourceClass } from '@figurecollecting/scraper-plugin-contract';
import { HostRateLimiter } from '../../driver/hostRateLimiter.js';
import { flushRawCaptureSink, parseImageMaxBytes } from '../s3ObjectStore.js';
import { getRawCaptureSink } from '../s3ObjectStore.js';
import { createImageHostLimiter, createImageCaptureHookFromEnv } from './assembleImageCapture.js';
import { acquireRunLock, LOCK_HEARTBEAT_MS } from './galleryLock.js';
import { readWorklistFile } from './galleryWorklist.js';
import {
  DEFAULT_OUTCOME_MEMORY, allowedHostnames, createFetchObserver, createFileLedger, createMemoryLedger, createRecordingFetch, followAllowedRedirects, gateOnStop, parseAllowedOrigin, runGalleryCapture,
  type ConfirmingSink, type GalleryLedger, type GalleryReport,
} from './galleryDriver.js';
import { createHttpBytesFetch, type BytesFetchImpl } from './httpBytesFetch.js';
import { imageHostRateFor } from './imageHostRates.js';
import type { ImageBytesFetcher } from './imageBytes.js';
import { paceImageBytesByHost } from './imageBytesPacing.js';
import { createImageBytesRouter, type ImageCaptureHook } from './imageCaptureHook.js';
import { loadImageHostPolicy, type ImageHostPolicy } from './imageHostPolicy.js';

const DEFAULT_PROBE = 20;
const MAX_PROBE = 200;
const SOURCE_CLASSES: readonly string[] = ['manufacturer_press', 'retailer_studio', 'user_photo', 'unknown'];
const USAGE =
  'usage: gallery:capture --worklist <file.jsonl> --ledger <file.jsonl> [--probe [N]] [--max-files N] [--max-minutes N] ' +
  '[--pause-after N] [--pause-minutes N] [--resume] [--dry-run] [--source-class <class>]  (env: GALLERY_WORKLIST_PATH, GALLERY_LEDGER_PATH, GALLERY_ALLOWED_HOSTS = host or host:port, GALLERY_LOCK_PATH)';

/** The lease file's name beside GALLERY_LEDGER_PATH: one name, so every ledger kept there shares one lock. */
const LOCK_FILE_NAME = 'gallery-capture.lock';
export const EXIT_LOCKED = 8;

export interface GalleryArgs {
  worklist?: string;
  ledger?: string;
  allowedHosts: string[];
  probe?: number;
  maxFiles?: number;
  maxMinutes?: number;
  pauseAfter: number;
  pauseMinutes: number;
  sourceClass: SourceClass;
  resume: boolean;
  dryRun: boolean;
}

function whole(flag: string, v: string | undefined, max: number): number {
  const n = Number(v);
  if (v === undefined || !/^[0-9]+$/.test(v) || n < 1 || n > max) throw new Error(`${USAGE} (${flag} must be a whole number from 1 to ${max}, got '${v ?? ''}')`);
  return n;
}

/** argv + env -> options; throws a usage error (the CLI exits 2) on anything it does not understand. */
export function parseGalleryArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): GalleryArgs {
  const hosts = (env.GALLERY_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(h => h !== '').map(entry => {
    const origin = parseAllowedOrigin(entry);
    if (origin === undefined) throw new Error(`${USAGE} (GALLERY_ALLOWED_HOSTS entry '${entry.slice(0, 80)}' is not a host or host:port)`);
    return origin.port === undefined ? origin.host : `${origin.host}:${origin.port}`;
  });
  const out: GalleryArgs = {
    ...(env.GALLERY_WORKLIST_PATH ? { worklist: env.GALLERY_WORKLIST_PATH } : {}),
    ...(env.GALLERY_LEDGER_PATH ? { ledger: env.GALLERY_LEDGER_PATH } : {}),
    // no host is built in (hands-off plan C1: the engine names no site); main() refuses a run that names none
    allowedHosts: hosts,
    pauseAfter: env.GALLERY_PAUSE_AFTER ? whole('GALLERY_PAUSE_AFTER', env.GALLERY_PAUSE_AFTER, 1000) : 3,
    pauseMinutes: env.GALLERY_PAUSE_MINUTES ? whole('GALLERY_PAUSE_MINUTES', env.GALLERY_PAUSE_MINUTES, 100_000) : 360,
    sourceClass: 'unknown',
    resume: false,
    dryRun: false,
  };
  if (env.GALLERY_SOURCE_CLASS) {
    if (!SOURCE_CLASSES.includes(env.GALLERY_SOURCE_CLASS)) throw new Error(`${USAGE} (GALLERY_SOURCE_CLASS must be one of ${SOURCE_CLASSES.join(', ')})`);
    out.sourceClass = env.GALLERY_SOURCE_CLASS as SourceClass;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--resume') out.resume = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--worklist' || a === '--ledger') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${USAGE} (${a} requires a path)`);
      if (a === '--worklist') out.worklist = v; else out.ledger = v;
    } else if (a === '--probe') {
      out.probe = /^[0-9]+$/.test(argv[i + 1] ?? '') ? whole(a, argv[++i], MAX_PROBE) : DEFAULT_PROBE;
    } else if (a === '--max-files') out.maxFiles = whole(a, argv[++i], 100_000_000);
    else if (a === '--max-minutes') out.maxMinutes = whole(a, argv[++i], 100_000);
    else if (a === '--pause-after') out.pauseAfter = whole(a, argv[++i], 1000);
    else if (a === '--pause-minutes') out.pauseMinutes = whole(a, argv[++i], 100_000);
    else if (a === '--source-class') {
      const v = argv[++i];
      if (v === undefined || !SOURCE_CLASSES.includes(v)) throw new Error(`${USAGE} (--source-class must be one of ${SOURCE_CLASSES.join(', ')})`);
      out.sourceClass = v as SourceClass;
    } else throw new Error(`${USAGE} (got '${a}')`);
  }
  return out;
}

export function galleryExitCode(r: GalleryReport): number {
  if (r.stopped === 'interrupted') return 7;
  if (r.stopped === 'refused') return 4;
  // A probe answers one question, and the code follows the PRINTED verdict: PASS exits 0, anything else exits 5, including a probe whose
  // writes the store did not confirm (the driver already makes that a FAIL) and one that tripped the pause (the marker is still written
  // and the PAUSED line still printed). 3 and 6 are for a real run.
  if (r.probe !== undefined) return r.probe.verdict === 'PASS' && r.itemsWithFailures === 0 ? 0 : 5;
  if (r.stopped === 'paused' || r.stopped === 'paused-marker') return 3;
  if (r.itemsWithFailures > 0) return 6;
  return 0;
}

export interface GalleryMainDeps {
  env?: NodeJS.ProcessEnv;
  /** What confirms a put (default: the process's raw store sink, when it keeps the counters). */
  sink?: ConfirmingSink;
  /** Aborted by SIGTERM / SIGINT (the entry wires them): the run stops issuing requests and exits 7. */
  signal?: AbortSignal;
  print?: (line: string) => void;
  now?: () => number;
  policy?: ImageHostPolicy;
  /** The http lane's transport (default: the global fetch). */
  baseFetch?: BytesFetchImpl;
  /** The capture hook over the composed fetcher (default: the env-built one, 100 images per item). */
  makeHook?: (fetchBytes: ImageBytesFetcher, env: NodeJS.ProcessEnv) => ImageCaptureHook;
  /** Drain the raw store sink before exit (default: flushRawCaptureSink). */
  flush?: () => Promise<unknown>;
  /** How often the lease is refreshed (default 10 s). */
  lockHeartbeatMs?: number;
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: GalleryMainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const print = deps.print ?? console.log;
  const now = deps.now ?? Date.now;
  let args: GalleryArgs;
  try { args = parseGalleryArgs(argv, env); } catch (e) { print((e as Error).message); return 2; }
  if (args.allowedHosts.length === 0) { print(`${USAGE} (GALLERY_ALLOWED_HOSTS must name the image host(s) this run may fetch from)`); return 2; }
  if (args.worklist === undefined) { print(`${USAGE} (a work list is required)`); return 2; }
  if (!existsSync(args.worklist)) { print(`ERROR cannot read the work list ${args.worklist}`); return 2; }
  if (args.ledger === undefined && !args.dryRun) {
    print(`${USAGE} (a ledger path is required: without one a restart would fetch everything again)`);
    return 2;
  }

  // No explicit rate row, no run: the limiter's own default eases up toward ~3.65 files/s, faster than the rate decided for this host.
  // A dry run makes no request and is left alone. The rate and the policy are keyed by HOST NAME, so an origin entry is looked up by its host.
  if (!args.dryRun) {
    const rateFor = imageHostRateFor(env, print);
    const missing = allowedHostnames(args.allowedHosts).filter(h => rateFor(h) === undefined);
    if (missing.length > 0) {
      print(`REFUSED: no explicit rate row for ${missing.join(', ')} in IMAGE_HOST_RATE_JSON (e.g. {"${missing[0]}":{"intervalMs":333}}); a host with no decided rate is never fetched at the limiter default`);
      return 2;
    }
  }
  // The store's own ceiling is part of the Job's env: the sink skips a body over it and still calls it admitted, so without the number
  // a run cannot say which files are at rest. Copy the scraper Deployment's value; it is not defaulted here.
  const storeMaxBytes = parseImageMaxBytes(env.RAW_STORE_IMAGE_MAX_BYTES);
  if (!args.dryRun && storeMaxBytes === undefined) {
    print('REFUSED: RAW_STORE_IMAGE_MAX_BYTES is not set to a positive number of bytes (copy the scraper Deployment\'s value, e.g. 10485760): the raw store skips bodies over it, so the run must know the ceiling to say which files are at rest');
    return 2;
  }
  // One run at a time per HOST, on a lease that NEVER depends on the --ledger flag: a probe given its own ledger, in another directory, must
  // not run beside a live run. The lock is where the Job env says (GALLERY_LOCK_PATH, else beside GALLERY_LEDGER_PATH); with neither, a run
  // that could double up on the host does not start.
  let lock: ReturnType<typeof acquireRunLock> | undefined;
  const lockPath = env.GALLERY_LOCK_PATH || (env.GALLERY_LEDGER_PATH ? path.join(path.dirname(env.GALLERY_LEDGER_PATH), LOCK_FILE_NAME) : undefined);
  if (!args.dryRun && lockPath === undefined) {
    print(`REFUSED: no lock location: set GALLERY_LOCK_PATH (or GALLERY_LEDGER_PATH, beside which ${LOCK_FILE_NAME} is kept) in the Job env. Without one, a run given another --ledger could run beside a live one`);
    return 2;
  }
  if (lockPath !== undefined && !args.dryRun) {
    lock = acquireRunLock(lockPath);
    if (!lock.held) {
      const owner = lock.owner;
      print(`LOCKED: another run holds ${lockPath}${owner !== undefined ? ` (${owner.hostname}, heartbeat ${Math.max(0, Math.round((Date.now() - owner.heartbeatAt) / 1000))}s ago)` : ''}; this one made no request`);
      return EXIT_LOCKED;
    }
  }
  // A signal, or the loss of the lease, stops the run the same way.
  const stop = new AbortController();
  const relay = (): void => stop.abort();
  if (deps.signal?.aborted === true) stop.abort();
  else deps.signal?.addEventListener('abort', relay, { once: true });
  if (lock?.held) {
    lock.startHeartbeat(() => {
      print(`LOST the lock ${lockPath ?? ''}: another run took it over (this run's heartbeat did not reach the file); stopping`);
      stop.abort();
    }, deps.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS);
  }

  const flush = deps.flush ?? (() => flushRawCaptureSink({ env }));
  try {
    const ledger: GalleryLedger = args.ledger !== undefined ? createFileLedger(args.ledger) : createMemoryLedger();
    const observer = createFetchObserver({ pauseAfter: args.pauseAfter, now });
    const recording = createRecordingFetch(deps.baseFetch);
    const limiter: HostRateLimiter = createImageHostLimiter(env);
    // observer( follow-by-hand( paced( http lane over the manual-redirect transport ) ) ): every hop is paced and checked
    // gateOnStop sits under the pacer: a request already waiting for its slot is refused when its wait ends, if the run has been stopped
    const paced = paceImageBytesByHost(gateOnStop(createImageBytesRouter({ http: createHttpBytesFetch({ fetchImpl: recording.fetchImpl }) }), observer.stopped), limiter);
    const fetchBytes = observer.wrap(followAllowedRedirects(paced, { allowedHosts: args.allowedHosts, locationOf: recording.takeLocation }));
    const policy = deps.policy ?? loadImageHostPolicy(env);
    const hook = (deps.makeHook ?? ((f, e) => createImageCaptureHookFromEnv({ ...e, IMAGE_MAX_PER_ITEM: '100' }, { fetchBytes: f, policy })))(fetchBytes, env);

    const rawSink = getRawCaptureSink() as unknown as Partial<ConfirmingSink>;
    const sink: ConfirmingSink | undefined = deps.sink ?? (typeof rawSink.stats === 'function' && typeof rawSink.flush === 'function' ? (rawSink as ConfirmingSink) : undefined);
    const report = await runGalleryCapture(
      { hook, ...(sink !== undefined ? { sink } : {}), observer, policy, ledger, items: readWorklistFile(args.worklist), now, log: print, requests: () => recording.records },
      {
        allowedHosts: args.allowedHosts, sourceClass: args.sourceClass, pauseAfter: args.pauseAfter, pauseMs: args.pauseMinutes * 60_000,
        ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
        ...(args.maxMinutes !== undefined ? { maxMs: args.maxMinutes * 60_000 } : {}),
        ...(args.probe !== undefined ? { probe: args.probe } : {}),
        resume: args.resume, dryRun: args.dryRun,
        signal: stop.signal,
        ...(storeMaxBytes !== undefined ? { storeMaxBytes } : {}),
        // four times the hook's memo, wherever IMAGE_MEMO_SIZE puts it
        outcomeMemory: Math.max(DEFAULT_OUTCOME_MEMORY, 4 * (Number(env.IMAGE_MEMO_SIZE) > 0 ? Math.floor(Number(env.IMAGE_MEMO_SIZE)) : 0)),
      },
    );
    await hook.drain();
    await flush();
    const { probe, ...summary } = report;
    print(`GALLERY-REPORT ${JSON.stringify(summary)}`);
    if (probe !== undefined) {
      print(`PROBE ${probe.verdict}${probe.reasons.length > 0 ? `: ${probe.reasons.join('; ')}` : ''}`);
      for (const n of probe.notes) print(`  note: ${n}`);
      print(`PROBE-EVIDENCE ${JSON.stringify(probe.evidence)}`);
    }
    if (report.refusal !== undefined) print(`REFUSED: ${report.refusal}`);
    if (report.stopped === 'paused') print(`PAUSED until ${new Date(report.pausedUntil!).toISOString()}: ${report.pauseReason}`);
    if (report.stopped === 'paused-marker') print(`PAUSED until ${new Date(report.pausedUntil!).toISOString()} (marker in the ledger; --resume clears it)`);
    return galleryExitCode(report);
  } catch (e) {
    print(`gallery:capture failed: ${(e as Error).message}`);
    try { await flush(); } catch { /* the sink's own drain reports its losses */ }
    return 1;
  } finally {
    deps.signal?.removeEventListener('abort', relay);
    if (lock?.held) lock.release();
  }
}
