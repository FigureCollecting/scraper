/**
 * galleryCapture — the `gallery:capture` Job's body (MFC-GALLERY-2; docs/mfc-gallery-2.md).
 *
 * Composes the gallery driver from the pieces the ingest image lane already uses: the same capture hook (the same
 * sink and spine reporter built from the same env), the same host policy table, the same per-host pacing wrapper with
 * the limiter's rate taken from IMAGE_HOST_RATE_JSON, and a bytes router over two lanes only: plain http, and impit
 * (galleryImpitLane.ts: chrome profile, no cookie jar, no stored cookies) — so the browser lane is `unsupported` by construction,
 * not by configuration. The policy row picks the lane. The egress is direct unless the Job asks for the home line:
 *   - unset: a residential row is refused (exit 4);
 *   - GALLERY_EGRESS=direct: a residential row is fetched direct (its lane stands);
 *   - GALLERY_EGRESS=residential (GAL-RES, Ross's decision): a residential row is fetched through the scraper's OWN residential exit
 *     (RESIDENTIAL_PROXY_URL, resolved by the capture hook exactly as for the live image capture), on impit, only to the item page's
 *     store's own hosts, and only under GALLERY_MAX_BYTES (required: refused with exit 4 without it). The byte meter (galleryBytes.ts)
 *     counts every body the lanes read, and the run stops between files, before one that could cross the budget.
 * Nothing here fetches an image itself.
 *
 * Exit codes (one meaning each): 0 done (or a limit reached: files, minutes or the byte budget), 1 the run crashed, 2 bad arguments,
 * input or config (nothing ran; a GALLERY_MAX_BYTES that is not a positive whole number or is below what one request may read, an
 * IMAGE_RESIDENTIAL_BYTES_PER_DAY below it, an --item the work list does not hold), 3 paused (a block, a failure storm, or a live pause
 * marker), 4 refused (lane off, the host policy puts an allowed host on the browser lane or on residential egress the run is not
 * permitted, or GALLERY_EGRESS=residential without GALLERY_MAX_BYTES or without a residential exit), 5 probe not a PASS (a probe exits by
 * its printed verdict: 0 or 5), 6 the raw store did not confirm some item's files (unsettled, run again), 7 stopped by SIGTERM/SIGINT or
 * by losing the lock, 8 LOCKED (another run holds the lease; this one made no request).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SourceClass } from '@figurecollecting/scraper-plugin-contract';
import { HostRateLimiter } from '../../driver/hostRateLimiter.js';
import { getResidentialProxyUrl, redactProxyUrl } from '../residentialEgress.js';
import { flushRawCaptureSink, parseImageMaxBytes } from '../s3ObjectStore.js';
import { getRawCaptureSink } from '../s3ObjectStore.js';
import { createImageHostLimiter, createImageCaptureHookFromEnv } from './assembleImageCapture.js';
import { createByteMeter, meterFetch, meterImpit, releaseUnreadAfter } from './galleryBytes.js';
import { acquireRunLock, LOCK_HEARTBEAT_MS } from './galleryLock.js';
import { readWorklistFile } from './galleryWorklist.js';
import {
  DEFAULT_OUTCOME_MEMORY, allowedHostnames, createFetchObserver, createFileLedger, createMemoryLedger, createRecordingFetch, followAllowedRedirects, gateOnStop, guardGalleryDispatch, originEntryText, parseAllowedOrigin,
  runGalleryCapture, withDirectEgress,
  type ConfirmingSink, type GalleryLedger, type GalleryReport,
} from './galleryDriver.js';
import { createGalleryImpitFetch, galleryImpitFactory, impitReadyFirst, type GalleryImpitFactory } from './galleryImpitLane.js';
import { createHttpBytesFetch, type BytesFetchImpl } from './httpBytesFetch.js';
import { imageHostRateFor } from './imageHostRates.js';
import { DEFAULT_MAX_IMAGE_BYTES, type ImageBytesFetcher } from './imageBytes.js';
import { paceImageBytesByHost } from './imageBytesPacing.js';
import { createImageBytesRouter, type ImageCaptureHook } from './imageCaptureHook.js';
import { loadImageHostPolicy, type ImageHostPolicy } from './imageHostPolicy.js';

const DEFAULT_PROBE = 20;
const MAX_PROBE = 200;
const SOURCE_CLASSES: readonly string[] = ['manufacturer_press', 'retailer_studio', 'user_photo', 'unknown'];
const USAGE =
  'usage: gallery:capture --worklist <file.jsonl> --ledger <file.jsonl> [--probe [N]] [--max-files N] [--max-minutes N] ' +
  '[--pause-after N] [--pause-minutes N] [--resume] [--dry-run] [--source-class <class>] [--item <site/itemId>]...  (env: GALLERY_WORKLIST_PATH, GALLERY_LEDGER_PATH, ' +
  'GALLERY_ALLOWED_HOSTS = [http://]host[:port] (bare = https), GALLERY_LOCK_PATH, GALLERY_EGRESS = direct|residential, GALLERY_MAX_BYTES = bytes (required for residential))';

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
  /** GALLERY_EGRESS: `direct` turns a residential policy row direct; `residential` lets it go through the residential exit, under a budget. */
  egress?: 'direct' | 'residential';
  /** GALLERY_MAX_BYTES: the response body bytes this run may read (required with GALLERY_EGRESS=residential). */
  maxBytes?: number;
  /** --item site/itemId (repeatable): only these items of the work list. */
  items?: string[];
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
    if (origin === undefined) throw new Error(`${USAGE} (GALLERY_ALLOWED_HOSTS entry '${entry.slice(0, 80)}' is not [http://|https://]host[:port])`);
    return originEntryText(origin);
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
  const egress = env.GALLERY_EGRESS?.trim().toLowerCase();
  if (egress) {
    if (egress !== 'direct' && egress !== 'residential') {
      throw new Error(`${USAGE} (GALLERY_EGRESS must be direct or residential, or unset to refuse a residential policy row)`);
    }
    out.egress = egress;
  }
  const maxBytes = env.GALLERY_MAX_BYTES?.trim();
  if (maxBytes) {
    const n = Number(maxBytes);
    if (!/^[0-9]+$/.test(maxBytes) || n < 1 || !Number.isSafeInteger(n)) {
      throw new Error(`${USAGE} (GALLERY_MAX_BYTES must be a positive whole number of bytes, got '${maxBytes.slice(0, 40)}')`);
    }
    out.maxBytes = n;
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
    } else if (a === '--item') {
      const v = argv[++i];
      if (v === undefined || !/^[A-Za-z0-9._-]+\/[^\s/]+$/.test(v)) throw new Error(`${USAGE} (--item requires site/itemId, e.g. mfc/1005999)`);
      out.items = [...(out.items ?? []), v];
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
  /** The impit lane's session (default: the real impit, chrome profile, no cookie jar, no redirect following; the residential exit as its proxy only on a residential run). */
  makeImpit?: GalleryImpitFactory;
  /** The capture hook over the composed fetcher and the run's policy (default: the env-built one, 100 images per item). */
  makeHook?: (fetchBytes: ImageBytesFetcher, env: NodeJS.ProcessEnv, policy: ImageHostPolicy) => ImageCaptureHook;
  /** Drain the raw store sink before exit (default: flushRawCaptureSink). */
  flush?: () => Promise<unknown>;
  /** How often the lease is refreshed (default 10 s). */
  lockHeartbeatMs?: number;
  /** The scraper's residential exit (default: RESIDENTIAL_PROXY_URL as the process resolved it, the one the capture hook uses). */
  residentialProxy?: () => string | undefined;
  /** The per-file cap both lanes enforce (default the shared lanes' 32 MiB). */
  imageCapBytes?: number;
  /** The chunk a capped read may take past the cap (default READ_CHUNK_ALLOWANCE, 1 MiB). */
  readAllowanceBytes?: number;
}

/** Only the work-list entries of the named items (a bad line still passes, to be counted); `onMatch` is told of each one kept. */
async function* onlyItems<T extends { ok: true; item: { site: string; itemId: string } } | { ok: false }>(
  source: AsyncIterable<T>, wanted: ReadonlySet<string>, onMatch: () => void,
): AsyncGenerator<T> {
  for await (const entry of source) {
    if (entry.ok && !wanted.has(`${entry.item.site}/${entry.item.itemId}`)) continue;
    if (entry.ok) onMatch();
    yield entry;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2), deps: GalleryMainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const print = deps.print ?? console.log;
  const now = deps.now ?? Date.now;
  let args: GalleryArgs;
  try { args = parseGalleryArgs(argv, env); } catch (e) { print((e as Error).message); return 2; }
  // The home line (GAL-RES): only with a byte cap, and only through the scraper's own residential exit, the one the capture hook resolves.
  if (args.egress === 'residential' && args.maxBytes === undefined) {
    print("REFUSED: GALLERY_EGRESS=residential needs GALLERY_MAX_BYTES, the response bytes this run may read: the image bytes cross Ross's home line, which is his decision, and never without a cap. No request was made");
    return 4;
  }
  const residentialProxy = args.egress === 'residential' ? (deps.residentialProxy ?? getResidentialProxyUrl)() : undefined;
  if (args.egress === 'residential' && residentialProxy === undefined) {
    print("REFUSED: GALLERY_EGRESS=residential but RESIDENTIAL_PROXY_URL names no usable residential exit (copy the scraper Deployment's value): a residential row is never fetched from this node's own address. No request was made");
    return 4;
  }
  const capBytes = deps.imageCapBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const meter = createByteMeter({
    ...(args.maxBytes !== undefined ? { max: args.maxBytes } : {}), capBytes, ...(deps.readAllowanceBytes !== undefined ? { allowance: deps.readAllowanceBytes } : {}),
  });
  if (args.maxBytes !== undefined && args.maxBytes < meter.reserve) {
    print(`${USAGE} (GALLERY_MAX_BYTES (${args.maxBytes}) is below what one request may read (${meter.reserve} bytes: the ${capBytes}-byte per-file cap plus one chunk), so the run could not make a single request)`);
    return 2;
  }
  // The hook keeps its own rolling day cap on the residential exit (IMAGE_RESIDENTIAL_BYTES_PER_DAY, the live default 1 GiB). This run's
  // cap is the Job's GALLERY_MAX_BYTES, so the hook is handed that; an explicit lower day cap would stop the run file by file instead.
  if (args.egress === 'residential' && env.IMAGE_RESIDENTIAL_BYTES_PER_DAY !== undefined && env.IMAGE_RESIDENTIAL_BYTES_PER_DAY.trim() !== '') {
    const dayCap = Math.floor(Number(env.IMAGE_RESIDENTIAL_BYTES_PER_DAY.trim()));
    if (Number.isFinite(dayCap) && dayCap >= 0 && dayCap < args.maxBytes!) {
      print(`${USAGE} (IMAGE_RESIDENTIAL_BYTES_PER_DAY (${dayCap}) is below GALLERY_MAX_BYTES (${args.maxBytes}): the capture hook's own home-line day cap would stop the run first; lower GALLERY_MAX_BYTES or leave IMAGE_RESIDENTIAL_BYTES_PER_DAY out of the Job)`);
      return 2;
    }
  }
  const cleartext = args.allowedHosts.filter(e => e.startsWith('http://'));
  if (cleartext.length > 0) {
    print(`WARNING: GALLERY_ALLOWED_HOSTS allows cleartext http for ${cleartext.join(', ')}: what is fetched from there crosses the network unencrypted. List an http:// entry only for a host that is not served over https`);
  }
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
    // Each lane's transport is metered (galleryBytes.ts) under the recorder: every body a lane reads is counted, and on a budgeted run
    // read through its stream and cut past the per-file cap. A body the lane did not read is cancelled as the lane returns.
    const recording = createRecordingFetch(meterFetch(deps.baseFetch ?? (globalThis.fetch as unknown as BytesFetchImpl), meter));
    const limiter: HostRateLimiter = createImageHostLimiter(env);
    // observer( follow-by-hand( paced( stop gate( dispatch guard( http | impit lane, each over a recorded, metered, manual-redirect transport ) ) ) ) ):
    // every hop is paced and checked. gateOnStop sits under the pacer: a request already waiting for its slot is refused when its wait
    // ends, if the run has been stopped, or if the byte budget no longer holds a full reservation for it. The guard refuses, per request,
    // any proxy or residential egress (on a residential run: any but the scraper's residential exit, off impit, or off the store's own
    // hosts) and any UA but the lanes' Chrome string. impitReadyFirst sits over the pacer: impit's session (the residential exit's, for a
    // residential request) is built before an impit request takes its slot.
    const impit = createGalleryImpitFetch({
      makeImpit: deps.makeImpit ?? galleryImpitFactory(),
      wrap: (session, egress) => recording.wrapImpit(meterImpit(session, meter), egress),
      ...(residentialProxy !== undefined ? { residentialProxy } : {}),
      maxBytes: capBytes,
    });
    const lanes = releaseUnreadAfter(createImageBytesRouter({ http: createHttpBytesFetch({ fetchImpl: recording.fetchImpl, maxBytes: capBytes }), impit }), meter);
    const guarded = guardGalleryDispatch(lanes, residentialProxy !== undefined ? { proxyUrl: residentialProxy } : undefined);
    const paced = impitReadyFirst(paceImageBytesByHost(gateOnStop(guarded, () => observer.stopped() ?? meter.spent()), limiter), impit);
    const fetchBytes = observer.wrap(followAllowedRedirects(paced, { allowedHosts: args.allowedHosts, locationOf: recording.takeLocation }));
    // The policy row picks each host's lane. GALLERY_EGRESS=direct keeps the row and makes its egress direct; the hook and the driver's
    // preflight both see the policy given here, and each host it changes is named before the run starts.
    const rows = deps.policy ?? loadImageHostPolicy(env);
    const policy = args.egress === 'direct' ? withDirectEgress(rows) : rows;
    if (args.egress === 'direct') {
      for (const host of allowedHostnames(args.allowedHosts)) {
        if (rows.ruleFor(host).egress === 'residential') {
          print(`EGRESS ${host}: the policy row says residential; GALLERY_EGRESS=direct fetches it from this node's own address, on the lane the row names, never through the home line`);
        }
      }
    }
    if (residentialProxy !== undefined) {
      const home = allowedHostnames(args.allowedHosts).filter(h => rows.ruleFor(h).egress === 'residential');
      for (const host of home) {
        print(`EGRESS ${host}: residential, through the scraper's residential exit ${redactProxyUrl(residentialProxy)} (RESIDENTIAL_PROXY_URL, as the live image capture reaches it), on the ${rows.ruleFor(host).lane ?? 'inherited'} lane; budget ${meter.max} bytes (GALLERY_MAX_BYTES) read in this run, stopping between files before one that could cross it`);
      }
      if (home.length === 0) print(`EGRESS: GALLERY_EGRESS=residential, but no allowed host's policy row says residential: every host is fetched from this node's own address; budget ${meter.max} bytes (GALLERY_MAX_BYTES)`);
    } else if (meter.max !== undefined) {
      print(`BUDGET ${meter.max} bytes (GALLERY_MAX_BYTES) read in this run, stopping between files before one that could cross it`);
    }
    // The hook's own day cap on the residential exit is this run's budget (a lower explicit one was refused above).
    const hookEnv: NodeJS.ProcessEnv = { ...env, IMAGE_MAX_PER_ITEM: '100', ...(residentialProxy !== undefined ? { IMAGE_RESIDENTIAL_BYTES_PER_DAY: String(meter.max) } : {}) };
    const hook = (deps.makeHook ?? ((f, e, p) => createImageCaptureHookFromEnv(e, { fetchBytes: f, policy: p })))(fetchBytes, hookEnv, policy);
    const wanted = args.items !== undefined ? new Set(args.items) : undefined;
    let matched = 0;
    const listed = readWorklistFile(args.worklist);

    const rawSink = getRawCaptureSink() as unknown as Partial<ConfirmingSink>;
    const sink: ConfirmingSink | undefined = deps.sink ?? (typeof rawSink.stats === 'function' && typeof rawSink.flush === 'function' ? (rawSink as ConfirmingSink) : undefined);
    const report = await runGalleryCapture(
      {
        hook, ...(sink !== undefined ? { sink } : {}), observer, policy, ledger, now, log: print, requests: () => recording.records, meter,
        items: wanted === undefined ? listed : onlyItems(listed, wanted, () => { matched++; }),
      },
      {
        allowedHosts: args.allowedHosts, sourceClass: args.sourceClass, pauseAfter: args.pauseAfter, pauseMs: args.pauseMinutes * 60_000,
        ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
        ...(args.maxMinutes !== undefined ? { maxMs: args.maxMinutes * 60_000 } : {}),
        ...(args.probe !== undefined ? { probe: args.probe } : {}),
        resume: args.resume, dryRun: args.dryRun,
        signal: stop.signal,
        ...(residentialProxy !== undefined ? { residential: true } : {}),
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
    if (report.stopped === 'budget') {
      print(meter.spent() !== undefined
        ? `STOPPED at the byte budget: ${report.bytesRead} of ${report.budget} bytes read (one more file may read up to ${meter.reserve}); what was not fetched stays unsettled for the next run`
        : "STOPPED: the capture hook's home-line day cap (IMAGE_RESIDENTIAL_BYTES_PER_DAY) skipped a file; what was not fetched stays unsettled for the next run");
    }
    // Only a list walked to its end can say an item is not in it: a refusal or a pause marker stops before the first line is read.
    if (wanted !== undefined && matched === 0 && report.stopped === 'done') {
      print(`NOTE: --item ${[...wanted].join(', ')} matched no item in the work list; nothing was fetched`);
      return 2;
    }
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
