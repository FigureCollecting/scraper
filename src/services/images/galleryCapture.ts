/**
 * galleryCapture — the `gallery:capture` Job's body (MFC-GALLERY-2; docs/mfc-gallery-2.md).
 *
 * Composes the gallery driver from the pieces the ingest image lane already uses: the same capture hook (the same
 * sink and spine reporter built from the same env), the same host policy table, the same per-host pacing wrapper with
 * the limiter's rate taken from IMAGE_HOST_RATE_JSON, and a plain-http-only bytes router — so any other lane is
 * `unsupported` by construction, not by configuration. Nothing here fetches an image itself.
 *
 * Exit codes: 0 done (or a limit reached), 3 paused (a block, or a live pause marker), 4 refused (lane off or the host
 * policy is not plain http + direct), 5 probe not a PASS, 2 bad arguments or input (nothing ran), 1 the run crashed.
 */
import { existsSync } from 'node:fs';
import type { SourceClass } from '@figurecollecting/scraper-plugin-contract';
import { HostRateLimiter } from '../../driver/hostRateLimiter.js';
import { flushRawCaptureSink } from '../s3ObjectStore.js';
import { getRawCaptureSink } from '../s3ObjectStore.js';
import { createImageHostLimiter, createImageCaptureHookFromEnv } from './assembleImageCapture.js';
import { acquireRunLock } from './galleryLock.js';
import { readWorklistFile } from './galleryWorklist.js';
import {
  createFetchObserver, createFileLedger, createMemoryLedger, createRecordingFetch, followAllowedRedirects, runGalleryCapture,
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
  '[--pause-after N] [--pause-minutes N] [--resume] [--dry-run] [--source-class <class>]  (env: GALLERY_WORKLIST_PATH, GALLERY_LEDGER_PATH, GALLERY_ALLOWED_HOSTS)';

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
  const hosts = (env.GALLERY_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(h => h !== '');
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
  if (r.stopped === 'paused' || r.stopped === 'paused-marker') return 3;
  if (r.itemsWithFailures > 0) return 6;
  if (r.probe !== undefined && r.probe.verdict !== 'PASS') return 5;
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
  // A dry run makes no request and is left alone.
  if (!args.dryRun) {
    const rateFor = imageHostRateFor(env, print);
    const missing = args.allowedHosts.filter(h => rateFor(h) === undefined);
    if (missing.length > 0) {
      print(`REFUSED: no explicit rate row for ${missing.join(', ')} in IMAGE_HOST_RATE_JSON (e.g. {"${missing[0]}":{"intervalMs":333}}); a host with no decided rate is never fetched at the limiter default`);
      return 2;
    }
  }
  // One run at a time per ledger: a second makes no request.
  let lock: ReturnType<typeof acquireRunLock> | undefined;
  if (args.ledger !== undefined && !args.dryRun) {
    lock = acquireRunLock(`${args.ledger}.lock`);
    if (!lock.held) {
      print(`LOCKED: another run holds ${args.ledger}.lock${lock.pid !== undefined ? ` (pid ${lock.pid})` : ''}; this one made no request`);
      return 3;
    }
  }

  const flush = deps.flush ?? (() => flushRawCaptureSink({ env }));
  try {
    const ledger: GalleryLedger = args.ledger !== undefined ? createFileLedger(args.ledger) : createMemoryLedger();
    const observer = createFetchObserver({ pauseAfter: args.pauseAfter, now });
    const recording = createRecordingFetch(deps.baseFetch);
    const limiter: HostRateLimiter = createImageHostLimiter(env);
    // observer( follow-by-hand( paced( http lane over the manual-redirect transport ) ) ): every hop is paced and checked
    const paced = paceImageBytesByHost(createImageBytesRouter({ http: createHttpBytesFetch({ fetchImpl: recording.fetchImpl }) }), limiter);
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
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
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
    if (lock?.held) lock.release();
  }
}
