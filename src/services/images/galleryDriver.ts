/**
 * galleryDriver — feeds an ordered work list of gallery urls through the SAME image capture hook every other
 * image takes (MFC-GALLERY-2; design in docs/mfc-gallery-2.md).
 *
 * It writes no row, stores no byte and decides nothing about an image. Every file it asks for goes through
 * `hook.capture()`, so the lane decision, the per-host pacing, the size and image-type guards, the
 * content-addressed raw original, the spine's capture report and, downstream, the media derivative path all apply
 * exactly as they do for an image found during an ingest. What the driver adds is only WHICH urls, in what order, and
 * when to stop:
 *
 *   - a LEDGER (append-only JSONL) so a restart fetches nothing it has already settled — a wasted request is a cost;
 *   - an AUTO-PAUSE: N consecutive blocked fetches (403, 429, 503, a cloudflare mitigation, a 2xx that is not an image,
 *     a host cooling from a challenge) stop the run, leave the blocked urls unsettled and write a pause marker the next
 *     run honours;
 *   - a PROBE: the first N files through the real hook and sink, judged on evidence (no cookie sent, no challenge, no
 *     redirect, plain 200 images from the allowed host), so the first deployed run proves what the design assumes;
 *   - REFUSALS: it will not start with the lane off (it would fetch bytes only to drop them), nor unless the host
 *     policy puts every allowed host on the plain http lane with direct egress.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { SourceClass } from '@figurecollecting/scraper-plugin-contract';
import type { BytesFetchImpl } from './httpBytesFetch.js';
import type { ImageBytesFetcher, ImageBytesResult } from './imageBytes.js';
import type { ImageCaptureHook } from './imageCaptureHook.js';
import { chooseImageLane, type ImageHostPolicy } from './imageHostPolicy.js';
import type { WorklistItem } from './galleryWorklist.js';

// ---------------------------------------------------------------------------
// observing the fetches
// ---------------------------------------------------------------------------
export interface FetchObservation {
  url: string;
  ok: boolean;
  status?: number;
  reason?: string;
  contentType?: string;
  bytes?: number;
  finalUrl?: string;
  signals?: Record<string, string>;
  ms: number;
}
export type ObservationClass = 'ok' | 'blocked' | 'gone' | 'oversize' | 'trouble';

/** What one fetch says about the host. Blocked is the only class that counts toward a pause. */
export function classifyObservation(o: FetchObservation): ObservationClass {
  if (o.ok) return 'ok';
  if (o.signals?.['cf-mitigated'] !== undefined) return 'blocked';
  if (o.reason === 'refused') return 'blocked';
  if (o.reason === 'not-image' && o.status !== undefined && o.status >= 200 && o.status <= 299) return 'blocked';
  if (o.reason === 'too-large') return 'oversize';
  if (o.reason === 'http-status') {
    if (o.status === 403 || o.status === 429 || o.status === 503) return 'blocked';
    if (o.status === 404 || o.status === 410) return 'gone';
  }
  return 'trouble';
}

export interface FetchObserver {
  /** Wrap the (paced) bytes fetcher: every call is recorded, and once tripped no call reaches the network. */
  wrap(inner: ImageBytesFetcher): ImageBytesFetcher;
  /** The observations since the last take. */
  take(): FetchObservation[];
  /** Why the breaker opened, or undefined while it is closed. */
  tripped(): string | undefined;
}

export function createFetchObserver(opts: { pauseAfter: number; now: () => number }): FetchObserver {
  let seen: FetchObservation[] = [];
  let streak = 0;
  let trip: string | undefined;
  return {
    wrap(inner) {
      return async (url, options) => {
        if (trip !== undefined) return { ok: false, reason: 'refused', detail: `gallery driver paused: ${trip}` };
        const t0 = opts.now();
        let res: ImageBytesResult;
        try {
          res = await inner(url, options);
        } catch (err) {
          seen.push({ url, ok: false, reason: 'threw', ms: opts.now() - t0 });
          throw err;
        }
        const ms = opts.now() - t0;
        const o: FetchObservation = res.ok
          ? { url, ok: true, status: res.status, contentType: res.contentType, bytes: res.bytes.length, finalUrl: res.finalUrl, ms }
          : {
              url, ok: false, reason: res.reason, ms,
              ...(res.status !== undefined ? { status: res.status } : {}),
              ...(res.contentType !== undefined ? { contentType: res.contentType } : {}),
              ...(res.signals !== undefined ? { signals: res.signals } : {}),
            };
        seen.push(o);
        const c = classifyObservation(o);
        if (c === 'blocked') {
          streak += 1;
          if (streak >= opts.pauseAfter) trip = `${streak} consecutive blocked fetches (last: ${o.status ?? o.reason} on ${pathOf(url)})`;
        } else if (c === 'ok') {
          streak = 0;
        }
        return res;
      };
    },
    take() {
      const out = seen;
      seen = [];
      return out;
    },
    tripped: () => trip,
  };
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 80);
  }
};
const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------
export type Settled = 'stored' | 'gone' | 'oversize';
export interface GalleryLedger {
  has(url: string): boolean;
  settle(url: string, how: Settled): void;
  pausedUntil(): number | undefined;
  pause(until: number, reason: string): void;
  clearPause(): void;
}

export function createMemoryLedger(): GalleryLedger {
  const done = new Set<string>();
  let until: number | undefined;
  return {
    has: url => done.has(url),
    settle: url => void done.add(url),
    pausedUntil: () => until,
    pause: u => { until = u; },
    clearPause: () => { until = undefined; },
  };
}

/** Append-only JSONL: {"u":url,"s":how} per settled url, {"pause":until,"why":text} / {"pause":null} for the marker. */
export function createFileLedger(file: string): GalleryLedger {
  const memory = createMemoryLedger();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
        if (typeof r.u === 'string' && (r.s === 'stored' || r.s === 'gone' || r.s === 'oversize')) memory.settle(r.u, r.s);
        else if ('pause' in r) {
          if (typeof r.pause === 'number') memory.pause(r.pause, String(r.why ?? ''));
          else if (r.pause === null) memory.clearPause();
        }
      } catch {
        /* a torn last line from a killed process: skipped, the url is simply fetched again */
      }
    }
  }
  const append = (record: Record<string, unknown>) => appendFileSync(file, JSON.stringify(record) + '\n');
  return {
    has: url => memory.has(url),
    settle(url, how) { memory.settle(url, how); append({ u: url, s: how }); },
    pausedUntil: () => memory.pausedUntil(),
    pause(until, why) { memory.pause(until, why); append({ pause: until, why }); },
    clearPause() { memory.clearPause(); append({ pause: null }); },
  };
}

// ---------------------------------------------------------------------------
// what the http lane sent and got back (probe evidence: names and flags, never values)
// ---------------------------------------------------------------------------
export interface RequestRecord {
  url: string;
  sentHeaderNames: string[];
  status: number;
  redirected: boolean;
  setCookie: boolean;
  cfMitigated?: string;
  cfRay?: string;
}
const MAX_RECORDS = 1000;

export function createRecordingFetch(inner: BytesFetchImpl = globalThis.fetch as unknown as BytesFetchImpl): { fetchImpl: BytesFetchImpl; records: RequestRecord[] } {
  const records: RequestRecord[] = [];
  const norm = (u: string): string => { try { return new URL(u).toString(); } catch { return u; } };
  const fetchImpl: BytesFetchImpl = async (url, init) => {
    const res = await inner(url, init);
    const rec: RequestRecord = {
      url,
      sentHeaderNames: Object.keys(init.headers ?? {}).map(h => h.toLowerCase()),
      status: res.status,
      redirected: res.url !== undefined && norm(res.url) !== norm(url),
      setCookie: res.headers.get('set-cookie') !== null,
      cfMitigated: res.headers.get('cf-mitigated') ?? undefined,
      cfRay: res.headers.get('cf-ray') ?? undefined,
    };
    records.push(rec);
    if (records.length > MAX_RECORDS) records.shift();
    return res;
  };
  return { fetchImpl, records };
}

// ---------------------------------------------------------------------------
// the probe's verdict
// ---------------------------------------------------------------------------
export interface ProbeEvidence {
  path: string;
  status?: number;
  contentType?: string;
  bytes?: number;
  ms: number;
  outcome: ObservationClass;
  sentHeaderNames?: string[];
  setCookie?: boolean;
  cfRay?: string;
  redirected?: boolean;
}
export interface ProbeVerdict {
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  reasons: string[];
  notes: string[];
  evidence: ProbeEvidence[];
}

export function judgeProbe(input: { observations: FetchObservation[]; requests: RequestRecord[]; allowedHosts: readonly string[]; wanted: number; exhausted?: boolean }): ProbeVerdict {
  const { observations, requests, allowedHosts } = input;
  const reasons = new Map<string, number>();
  const notes: string[] = [];
  const add = (text: string) => reasons.set(text, (reasons.get(text) ?? 0) + 1);
  const byUrl = new Map(requests.map(r => [r.url, r] as const));

  for (const o of observations) {
    if (o.signals?.['cf-mitigated'] !== undefined) add(`challenge: cf-mitigated ${o.signals['cf-mitigated']}`);
    if (!o.ok) {
      if (o.reason === 'not-image') add(`not an image: a ${o.status ?? '2xx'} answered with ${o.contentType ?? 'no content type'}`);
      else add(`status ${o.status ?? o.reason ?? 'unknown'} (${o.reason ?? 'failed'})`);
    } else {
      if (o.status !== 200) add(`status ${o.status} where 200 was expected`);
      const host = hostOf(o.finalUrl ?? o.url);
      if (host === undefined || !allowedHosts.includes(host)) add(`bytes came from another host (${host ?? 'unparseable'})`);
    }
  }
  let setCookies = 0;
  for (const r of requests) {
    if (r.sentHeaderNames.includes('cookie')) add('a cookie header was sent');
    if (r.sentHeaderNames.includes('authorization')) add('an authorization header was sent');
    if (r.redirected) add('the response was redirected');
    if (r.cfMitigated !== undefined) add(`challenge: cf-mitigated ${r.cfMitigated}`);
    if (r.setCookie) setCookies++;
  }
  if (setCookies > 0) notes.push(`Set-Cookie seen on ${setCookies} response(s); nothing was sent back, so it is information only`);

  const evidence: ProbeEvidence[] = observations.map(o => {
    const r = byUrl.get(o.url);
    return {
      path: pathOf(o.url), ms: o.ms, outcome: classifyObservation(o),
      ...(o.status !== undefined ? { status: o.status } : {}),
      ...(o.contentType !== undefined ? { contentType: o.contentType } : {}),
      ...(o.bytes !== undefined ? { bytes: o.bytes } : {}),
      ...(r ? { sentHeaderNames: r.sentHeaderNames, setCookie: r.setCookie, redirected: r.redirected, ...(r.cfRay !== undefined ? { cfRay: r.cfRay } : {}) } : {}),
    };
  });
  const reasonList = [...reasons].map(([text, n]) => (n > 1 ? `${text} (x${n})` : text));
  if (reasonList.length > 0) return { verdict: 'FAIL', reasons: reasonList, notes, evidence };
  if (observations.length === 0) return { verdict: 'INCONCLUSIVE', reasons: ['no request was made'], notes, evidence };
  const unrecorded = observations.filter(o => o.ok && !byUrl.has(o.url)).length;
  if (unrecorded > 0) {
    return { verdict: 'INCONCLUSIVE', reasons: [`no request record for ${unrecorded} fetched file(s): what was sent cannot be shown, so "no cookies" is not proven`], notes, evidence };
  }
  if (observations.length < input.wanted && input.exhausted !== true) {
    return { verdict: 'INCONCLUSIVE', reasons: [`only ${observations.length} of ${input.wanted} files were fetched`], notes, evidence };
  }
  return { verdict: 'PASS', reasons: [], notes, evidence };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------
export interface GalleryRunOptions {
  /** Hosts a file may be fetched from; any other url in the list is counted and skipped. */
  allowedHosts: readonly string[];
  /** Provenance claim for these depictions until Ross rules; default 'unknown'. */
  sourceClass?: SourceClass;
  /** Stop after this many files in the run. */
  maxFiles?: number;
  /** Wall-clock budget; checked between items. */
  maxMs?: number;
  /** Consecutive blocked fetches that pause the run (the observer's own setting is the one that trips). */
  pauseAfter: number;
  /** How long a pause marker holds. */
  pauseMs: number;
  /** Probe mode: this many files, judged on evidence, nothing settled. */
  probe?: number;
  /** Clear a live pause marker before starting. */
  resume?: boolean;
  /** Read the list and the ledger, call nothing. */
  dryRun?: boolean;
}

export interface GalleryDeps {
  hook: Pick<ImageCaptureHook, 'capture' | 'stats'>;
  observer: FetchObserver;
  policy: ImageHostPolicy;
  ledger: GalleryLedger;
  items: AsyncIterable<{ ok: true; item: WorklistItem; dropped: number } | { ok: false; line: number; error: string }>;
  now: () => number;
  log: (line: string) => void;
  /** The http lane's request records (probe evidence). */
  requests: () => RequestRecord[];
}

export type GalleryStop = 'done' | 'limit' | 'time' | 'paused' | 'paused-marker' | 'refused';
export interface GalleryReport {
  mode: 'run' | 'probe' | 'dry-run';
  stopped: GalleryStop;
  refusal?: string;
  pauseReason?: string;
  pausedUntil?: number;
  items: number;
  planned: number;
  fetched: number;
  stored: number;
  gone: number;
  oversize: number;
  blocked: number;
  trouble: number;
  skippedLedger: number;
  notAllowedHost: number;
  badLines: number;
  itemsWithFailures: number;
  probe?: ProbeVerdict;
}

/** The host policy must put every allowed host on the plain http lane with direct egress: no cookies, no browser, no home line. */
function preflight(policy: ImageHostPolicy, pageUrl: string, hosts: readonly string[]): string | undefined {
  for (const host of hosts) {
    const d = chooseImageLane(pageUrl, `https://${host}/probe.jpg`, undefined, policy);
    if (!d.ok) return `the host policy refuses ${host}: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`;
    if (d.lane !== 'http' || d.egress !== 'direct') {
      return `${host} resolves to lane ${d.lane} with ${d.egress} egress; the gallery driver needs the plain http lane with direct egress — add IMAGE_HOST_POLICY_JSON {"${host}":{"lane":"http","egress":"direct"}}`;
    }
  }
  return undefined;
}

export async function runGalleryCapture(deps: GalleryDeps, opts: GalleryRunOptions): Promise<GalleryReport> {
  const mode: GalleryReport['mode'] = opts.probe !== undefined ? 'probe' : opts.dryRun === true ? 'dry-run' : 'run';
  const report: GalleryReport = {
    mode, stopped: 'done', items: 0, planned: 0, fetched: 0, stored: 0, gone: 0, oversize: 0, blocked: 0, trouble: 0,
    skippedLedger: 0, notAllowedHost: 0, badLines: 0, itemsWithFailures: 0,
  };
  const started = deps.now();
  const allowed = opts.allowedHosts.map(h => h.toLowerCase());
  const sourceClass: SourceClass = opts.sourceClass ?? 'unknown';
  const budget = opts.probe ?? opts.maxFiles;

  const lane = deps.hook.stats();
  if (!lane.enabled) {
    return { ...report, stopped: 'refused', refusal: `the image capture lane is off${lane.reason ? ` (${lane.reason})` : ''}; refusing to fetch what would be dropped` };
  }
  if (opts.resume === true) deps.ledger.clearPause();
  const until = deps.ledger.pausedUntil();
  if (until !== undefined) {
    if (until > deps.now()) return { ...report, stopped: 'paused-marker', pausedUntil: until };
    deps.ledger.clearPause();
  }

  const probeObservations: FetchObservation[] = [];
  let preflighted = false;
  let exhausted = true;

  for await (const entry of deps.items) {
    if (!entry.ok) { report.badLines++; continue; }
    const item = entry.item;
    if (opts.maxMs !== undefined && deps.now() - started >= opts.maxMs) { report.stopped = 'time'; exhausted = false; break; }
    if (budget !== undefined && report.planned >= budget) { report.stopped = 'limit'; exhausted = false; break; }
    if (!preflighted) {
      const problem = preflight(deps.policy, item.pageUrl, allowed);
      if (problem !== undefined) return { ...report, stopped: 'refused', refusal: problem };
      preflighted = true;
    }

    const wanted = item.entries.filter(e => {
      const host = hostOf(e.src);
      if (host === undefined || !allowed.includes(host)) { report.notAllowedHost++; return false; }
      if (deps.ledger.has(e.src)) { report.skippedLedger++; return false; }
      return true;
    });
    const room = budget === undefined ? wanted.length : Math.max(0, budget - report.planned);
    const todo = wanted.slice(0, room);
    if (todo.length === 0) continue;
    report.items++;
    report.planned += todo.length;
    if (mode === 'dry-run') continue;

    const before = deps.hook.stats();
    await deps.hook.capture({
      site: item.site,
      itemId: item.itemId,
      pageUrl: item.pageUrl,
      fields: {},
      ruleset: {
        describeImages: () => todo.map(e => ({
          url: e.src, role: 'gallery' as const, position: e.position, sourceClass,
          // Never defaulted to general: an item whose level is not known is gated as the most restrictive.
          contentLevel: item.contentLevel ?? ('unknown' as const),
        })),
      },
      origin: 'ingest',
    });
    const after = deps.hook.stats();
    const obs = deps.observer.take();

    // `failed` also counts fetch faults the observations already account for; what is left is the sink losing bytes
    // we did fetch. Such an item is re-driven whole rather than settled, so a stored-but-lost file is never forgotten.
    const accounted = obs.filter(o => !o.ok && (o.reason === 'http-status' || o.reason === 'timeout' || o.reason === 'threw')).length;
    const sinkLost = after.failed - before.failed - accounted > 0;
    if (sinkLost) report.itemsWithFailures++;

    for (const o of obs) {
      report.fetched++;
      const c = classifyObservation(o);
      if (c === 'ok') report.stored++; else report[c]++;
      if (mode === 'probe') { probeObservations.push(o); continue; }
      if (c === 'ok' && !sinkLost) deps.ledger.settle(o.url, 'stored');
      else if (c === 'gone') deps.ledger.settle(o.url, 'gone');
      else if (c === 'oversize') deps.ledger.settle(o.url, 'oversize');
    }
    deps.log(`[gallery] ${item.site}/${item.itemId}: ${obs.length} fetched, ${report.stored} stored so far, ${report.blocked} blocked`);

    const trip = deps.observer.tripped();
    if (trip !== undefined) {
      const pausedUntil = deps.now() + opts.pauseMs;
      deps.ledger.pause(pausedUntil, trip);
      report.stopped = 'paused';
      report.pauseReason = trip;
      report.pausedUntil = pausedUntil;
      exhausted = false;
      break;
    }
    if (mode !== 'probe' && opts.maxFiles !== undefined && report.fetched >= opts.maxFiles) { report.stopped = 'limit'; exhausted = false; break; }
    if (mode === 'probe' && report.fetched >= (opts.probe ?? 0)) { report.stopped = 'limit'; exhausted = false; break; }
  }

  if (mode === 'probe') {
    report.probe = judgeProbe({ observations: probeObservations, requests: deps.requests(), allowedHosts: allowed, wanted: opts.probe ?? 0, exhausted });
  }
  return report;
}
