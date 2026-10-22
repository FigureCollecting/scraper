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
import { sniffImageType } from '../objectStoreCaptureSink.js';
import type { BytesFetchImpl } from './httpBytesFetch.js';
import type { ImageBytesFetcher, ImageBytesResult } from './imageBytes.js';
import type { ImageCaptureHook } from './imageCaptureHook.js';
import { chooseImageLane, type ImageHostPolicy } from './imageHostPolicy.js';
import { canonicalImageUrl, type WorklistItem } from './galleryWorklist.js';

// ---------------------------------------------------------------------------
// observing the fetches
// ---------------------------------------------------------------------------
export interface FetchObservation {
  url: string;
  ok: boolean;
  status?: number;
  reason?: string;
  /** Why a refusal was made (never a header or cookie value). */
  detail?: string;
  contentType?: string;
  bytes?: number;
  /** An ok fetch whose body the store will not keep: empty, or not JPEG, PNG, GIF, WebP or AVIF by its magic bytes (the lane trusts a declared image/* type; the sink does not). */
  notImage?: boolean;
  finalUrl?: string;
  signals?: Record<string, string>;
  ms: number;
}
export type ObservationClass = 'ok' | 'blocked' | 'gone' | 'oversize' | 'trouble' | 'notimage';

/** What one fetch says about the host. Blocked, trouble and notimage count toward a pause; only a good image resets it. */
export function classifyObservation(o: FetchObservation): ObservationClass {
  if (o.ok) return o.notImage === true ? 'notimage' : 'ok';
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
  /** Stop issuing: every later call is refused without touching the network, and is not an observation. */
  stop(reason: string): void;
  /** Why it was stopped, or undefined while it runs. */
  stopped(): string | undefined;
}

/** The detail of a refusal caused by a stop: it is not a verdict on the host, so it is never recorded as an observation. */
export const STOP_DETAIL = 'gallery driver stopped: ';

/**
 * Refuse at DISPATCH once the run is stopped. Put it directly over the transport (under the pacing wrapper): a request that was
 * already waiting for its slot when the signal came is then refused when the wait ends, instead of going out after the stop.
 */
export function gateOnStop(inner: ImageBytesFetcher, stopped: () => string | undefined): ImageBytesFetcher {
  return async (url, options) => {
    const why = stopped();
    if (why !== undefined) return { ok: false, reason: 'refused', detail: `${STOP_DETAIL}${why}` };
    return inner(url, options);
  };
}

export function createFetchObserver(opts: { pauseAfter: number; now: () => number }): FetchObserver {
  let seen: FetchObservation[] = [];
  let streak = 0;
  let trip: string | undefined;
  let stopped: string | undefined;
  // Blocked fetches AND fetches that erred (a 5xx, a timeout, a dropped connection) are one streak: a dead or throttling origin
  // must not be asked for the rest of the list at the full pace. A success resets it; gone and oversize are verdicts on one url.
  const fail = (o: FetchObservation): void => {
    streak += 1;
    if (streak >= opts.pauseAfter) trip = `${streak} consecutive blocked or failed fetches (last: ${o.ok ? 'a body that is not an image' : (o.status ?? o.reason)} on ${pathOf(o.url)})`;
  };
  return {
    stop(reason) { stopped = reason; },
    stopped: () => stopped,
    wrap(inner) {
      return async (url, options) => {
        if (stopped !== undefined) return { ok: false, reason: 'refused', detail: `${STOP_DETAIL}${stopped}` };
        if (trip !== undefined) return { ok: false, reason: 'refused', detail: `gallery driver paused: ${trip}` };
        const t0 = opts.now();
        let res: ImageBytesResult;
        try {
          res = await inner(url, options);
        } catch (err) {
          const threw: FetchObservation = { url, ok: false, reason: 'threw', ms: opts.now() - t0 };
          seen.push(threw);
          fail(threw);
          throw err;
        }
        const ms = opts.now() - t0;
        if (!res.ok && res.reason === 'refused' && res.detail?.startsWith(STOP_DETAIL)) return res; // stopped at dispatch: no verdict on the host
        const o: FetchObservation = res.ok
          ? {
              url, ok: true, status: res.status, contentType: res.contentType, bytes: res.bytes.length, finalUrl: res.finalUrl, ms,
              // the sink decides by magic bytes, with the very function used here, so the two cannot disagree about what it keeps
              ...(res.bytes.length === 0 || sniffImageType(res.bytes) === undefined ? { notImage: true } : {}),
            }
          : {
              url, ok: false, reason: res.reason, ms,
              ...(res.reason === 'refused' && res.detail !== undefined ? { detail: res.detail } : {}),
              ...(res.status !== undefined ? { status: res.status } : {}),
              ...(res.contentType !== undefined ? { contentType: res.contentType } : {}),
              ...(res.signals !== undefined ? { signals: res.signals } : {}),
            };
        seen.push(o);
        const c = classifyObservation(o);
        if (c === 'blocked' || c === 'trouble' || c === 'notimage') fail(o);
        else if (c === 'ok') streak = 0;
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
/** One spelling of a host: trimmed, lowercased, no trailing root dot. The allow-list and every url are compared in it. */
export const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/\.+$/, '');
/**
 * One origin the run may fetch from: a host, and a port. A host named without a port means its DEFAULT ports (https 443, http 80);
 * `host:port` means that port and no other. A host name alone would also let a redirect reach any other service on the same host.
 */
export interface AllowedOrigin { host: string; port?: number }
export function parseAllowedOrigin(entry: string): AllowedOrigin | undefined {
  const m = /^([A-Za-z0-9._-]+)(?::([0-9]{1,5}))?$/.exec(entry.trim());
  if (m === null) return undefined;
  const host = normalizeHost(m[1]!);
  if (host === '') return undefined;
  if (m[2] === undefined) return { host };
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host, port } : undefined;
}
/** The compiled list; an entry that does not parse allows nothing (fail closed). */
const compileAllowed = (entries: readonly string[]): AllowedOrigin[] => entries.flatMap(e => { const o = parseAllowedOrigin(e); return o === undefined ? [] : [o]; });
/** The host names behind a list of origins: what the host policy, the rate rows and the probe preflight are keyed by. */
export const allowedHostnames = (entries: readonly string[]): string[] => [...new Set(compileAllowed(entries).map(o => o.host))];
export function originAllowed(url: string, allowed: readonly AllowedOrigin[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = normalizeHost(u.hostname);
  const explicit = u.port === '' ? undefined : Number(u.port); // WHATWG drops the scheme's own default port
  return allowed.some(a => a.host === host && (a.port === undefined ? explicit === undefined : (explicit ?? (u.protocol === 'https:' ? 443 : 80)) === a.port));
}

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------
/**
 * `skipped:too_large`: the raw store skips a body over RAW_STORE_IMAGE_MAX_BYTES; `skipped:not_image`: it skips a body that is empty or
 * whose magic bytes are not JPEG, PNG, GIF, WebP or AVIF (an HTML page served as image/jpeg, a BMP). Either way the file is real but will
 * never be at rest: it is settled, counted, never reported to the spine and not asked for again.
 */
/**
 * What the store CONFIRMED for a url during this run: the one thing a later item's memo hit can be settled on. Bounded (a run is millions
 * of urls); it only has to outlast the hook's own bounded memo, which can serve a url only while it still holds it. A url this forgets is
 * a memo hit with no known outcome, which is a failure (unsettled, fetched again next run), never a guess.
 */
/** What the raw store does with a fetched body. */
export type StoreVerdict = 'stored' | 'too_large' | 'not_image';
export function createOutcomeMemory(max: number): { get(url: string): StoreVerdict | undefined; set(url: string, v: StoreVerdict): void } {
  const m = new Map<string, StoreVerdict>();
  return {
    get(url) {
      const v = m.get(url);
      if (v !== undefined) { m.delete(url); m.set(url, v); } // a url that keeps being hit stays
      return v;
    },
    set(url, v) {
      m.delete(url);
      m.set(url, v);
      while (m.size > max) {
        const oldest = m.keys().next();
        if (oldest.done) break;
        m.delete(oldest.value);
      }
    },
  };
}
export const DEFAULT_OUTCOME_MEMORY = 200_000;
const SETTLED_AS: Record<StoreVerdict, Settled> = { stored: 'stored', too_large: 'skipped:too_large', not_image: 'skipped:not_image' };

export type Settled = 'stored' | 'gone' | 'oversize' | 'skipped:too_large' | 'skipped:not_image';
/**
 * Settlement is per (item, url), not per url: an item that shares a picture with another still needs its OWN depiction reported
 * (the hook's memo hit does that without a second fetch), so a url settled for one item says nothing about the next. `item` is
 * `site/itemId`, `url` the canonical form.
 */
export interface GalleryLedger {
  has(item: string, url: string): boolean;
  settle(item: string, url: string, how: Settled): void;
  pausedUntil(): number | undefined;
  pause(until: number, reason: string): void;
  clearPause(): void;
}

const settledKey = (item: string, url: string): string => `${item}\u0000${url}`;

export function createMemoryLedger(): GalleryLedger {
  const done = new Set<string>();
  let until: number | undefined;
  return {
    has: (item, url) => done.has(settledKey(item, url)),
    settle: (item, url) => void done.add(settledKey(item, url)),
    pausedUntil: () => until,
    pause: u => { until = u; },
    clearPause: () => { until = undefined; },
  };
}

/**
 * Append-only JSONL: {"i":"site/itemId","u":url,"s":how} per settled (item, url), {"pause":until,"why":text} / {"pause":null} for the
 * marker. A line without an item (the url-only format of the first cut, never run in bulk) is skipped: the file is fetched again,
 * and the content-addressed store dedupes what it already has.
 */
export function createFileLedger(file: string): GalleryLedger {
  const memory = createMemoryLedger();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
        if (typeof r.i === 'string' && typeof r.u === 'string' && (r.s === 'stored' || r.s === 'gone' || r.s === 'oversize' || r.s === 'skipped:too_large' || r.s === 'skipped:not_image')) memory.settle(r.i, r.u, r.s);
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
    has: (item, url) => memory.has(item, url),
    settle(item, url, how) { memory.settle(item, url, how); append({ i: item, u: url, s: how }); },
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

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The transport of the gallery's http lane. It NEVER lets the runtime follow a redirect (`redirect: 'manual'`): a hop is a request
 * to a host the allow-list has not looked at, so {@link followAllowedRedirects} takes it by hand. Each 3xx's absolute Location is
 * kept for the follower to collect.
 */
export function createRecordingFetch(inner: BytesFetchImpl = globalThis.fetch as unknown as BytesFetchImpl): { fetchImpl: BytesFetchImpl; records: RequestRecord[]; takeLocation: (url: string) => string | undefined } {
  const records: RequestRecord[] = [];
  const locations = new Map<string, string>();
  const norm = (u: string): string => { try { return new URL(u).toString(); } catch { return u; } };
  const fetchImpl: BytesFetchImpl = async (url, init) => {
    const res = await inner(url, { ...init, redirect: 'manual' });
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (location !== null && location !== '') {
        try { locations.set(url, new URL(location, url).href); } catch { /* an unparseable Location is no hop */ }
      }
    }
    const rec: RequestRecord = {
      url,
      sentHeaderNames: Object.keys(init.headers ?? {}).map(h => h.toLowerCase()),
      status: res.status,
      redirected: REDIRECT_STATUSES.has(res.status) || (res.url !== undefined && norm(res.url) !== norm(url)),
      setCookie: res.headers.get('set-cookie') !== null,
      cfMitigated: res.headers.get('cf-mitigated') ?? undefined,
      cfRay: res.headers.get('cf-ray') ?? undefined,
    };
    records.push(rec);
    if (records.length > MAX_RECORDS) records.shift();
    return res;
  };
  const takeLocation = (url: string): string | undefined => {
    const location = locations.get(url);
    locations.delete(url);
    return location;
  };
  return { fetchImpl, records, takeLocation };
}

/** Hops one image may take before it is refused. */
export const MAX_REDIRECT_HOPS = 5;

/**
 * Follow redirects BY HAND, over the paced fetcher (so every hop, a same-host one included, waits for the host's turn and books
 * its outcome), and only to a host the allow-list names. A hop to any other host is REFUSED before a request is sent to it: the
 * gallery never fetches, never stores and never settles a byte from outside GALLERY_ALLOWED_HOSTS. A cross-origin hop carries no
 * Referer (the item page was named to the first host, not to the next).
 */
export function followAllowedRedirects(
  paced: ImageBytesFetcher,
  opts: { allowedHosts: readonly string[]; locationOf: (url: string) => string | undefined; maxHops?: number },
): ImageBytesFetcher {
  const allowed = compileAllowed(opts.allowedHosts);
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const refused = (detail: string): ImageBytesResult => ({ ok: false, reason: 'refused', detail });
  return async (url, options) => {
    let current = url;
    let useOptions = options;
    for (let hop = 0; ; hop++) {
      const res = await paced(current, useOptions);
      if (res.ok) {
        const where = res.finalUrl ?? current;
        return originAllowed(where, allowed) ? res : refused(`the bytes came from ${describeOrigin(where)}, outside the allow-list`);
      }
      if (res.reason !== 'http-status' || res.status === undefined || !REDIRECT_STATUSES.has(res.status)) return res;
      const location = opts.locationOf(current);
      if (location === undefined) return res;
      if (hop >= maxHops) return refused(`more than ${maxHops} redirects`);
      let next: URL;
      try { next = new URL(location); } catch { return refused('an unparseable redirect Location'); }
      // never echoed, never fetched: a Location with credentials is how a password reaches a log
      if (next.username !== '' || next.password !== '') return refused('a redirect Location with credentials');
      if (!originAllowed(next.href, allowed)) return refused(`redirected to ${describeOrigin(next.href)}, outside the allow-list`);
      if (new URL(current).origin !== next.origin && useOptions?.referer !== undefined) {
        const { referer: _dropped, ...withoutReferer } = useOptions;
        useOptions = withoutReferer;
      }
      current = next.href;
    }
  };
}

/** scheme, host and port of a url, never its userinfo or path: safe to put in a message. */
function describeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return 'an unparseable url';
  }
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
  const { observations, requests } = input;
  const allowed = compileAllowed(input.allowedHosts);
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
      if (o.notImage === true) add(`not an image: a ${o.status ?? 200} body labelled ${o.contentType ?? 'image'} that the store would not keep (it keeps JPEG, PNG, GIF, WebP and AVIF)`);
      if (o.status !== 200) add(`status ${o.status} where 200 was expected`);
      const where = o.finalUrl ?? o.url;
      if (!originAllowed(where, allowed)) add(`bytes came from another origin (${describeOrigin(where)})`);
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
  /** Aborted by SIGTERM: stop issuing requests, confirm what is queued, settle only what the sink confirmed, and say so. */
  signal?: AbortSignal;
  /**
   * The raw store's own per-image ceiling (RAW_STORE_IMAGE_MAX_BYTES). The sink SKIPS a body over it and still reports it admitted, so
   * a fetch of that size is not stored: it is settled `skipped:too_large`. Without it a store-side skip cannot be explained and is
   * treated as a failure.
   */
  storeMaxBytes?: number;
  /** How many confirmed urls to keep for memo-hit settlement (default 200,000: four times the hook's default memo). */
  outcomeMemory?: number;
}

/**
 * What the raw store sink can say about a write. `capture()` only ADMITS bytes to a queue; the put runs later on a worker, and its
 * failure lands in the sink's own counters. A file is settled only once `flush()` has returned with none of these counters moved.
 */
export interface ConfirmingSink {
  /** Resolves once everything admitted has reached the store, or has failed trying. */
  flush(): Promise<void>;
  stats(): {
    assetFailed: number; dropped: number; droppedBytes: number; assetRefusedReserve: number;
    /** Bodies the sink admitted but never put: too large for the store, not an image, empty, or the lane off. */
    assetSkipped?: { tooLarge: number; notImage: number; empty: number; disabled: number };
  };
}
type SinkStats = ReturnType<ConfirmingSink['stats']>;
const lossOf = (s: SinkStats): number => s.assetFailed + s.dropped + s.droppedBytes + s.assetRefusedReserve;
const skippedOf = (s: SinkStats | undefined, kind: 'tooLarge' | 'notImage' | 'empty' | 'disabled'): number => s?.assetSkipped?.[kind] ?? 0;

export interface GalleryDeps {
  hook: Pick<ImageCaptureHook, 'capture' | 'stats' | 'forget'>;
  /** The sink the hook writes to. Required for every run that fetches: a url is never settled on an unconfirmed put. */
  sink?: ConfirmingSink;
  observer: FetchObserver;
  policy: ImageHostPolicy;
  ledger: GalleryLedger;
  items: AsyncIterable<{ ok: true; item: WorklistItem; dropped: number; capped?: number } | { ok: false; line: number; error: string }>;
  now: () => number;
  log: (line: string) => void;
  /** The http lane's request records (probe evidence). */
  requests: () => RequestRecord[];
}

export type GalleryStop = 'done' | 'limit' | 'time' | 'paused' | 'paused-marker' | 'refused' | 'interrupted';
export interface GalleryReport {
  mode: 'run' | 'probe' | 'dry-run';
  stopped: GalleryStop;
  refusal?: string;
  pauseReason?: string;
  pausedUntil?: number;
  items: number;
  planned: number;
  fetched: number;
  /** (item, picture) pairs now settled as stored: the store confirmed the put, or a sharing item's picture was confirmed earlier. Not "fetched". */
  stored: number;
  gone: number;
  oversize: number;
  /** Pairs settled `skipped:too_large`: the raw store skips bodies over its own ceiling. */
  skippedTooLarge: number;
  /** Pairs settled `skipped:not_image`: the raw store skips a body that is empty or not JPEG, PNG, GIF, WebP or AVIF. */
  skippedNotImage: number;
  blocked: number;
  trouble: number;
  skippedLedger: number;
  notAllowedHost: number;
  badLines: number;
  /** Entries left out because an item listed more than the cap (the first 100 by position are kept). */
  entriesCapped: number;
  /** Items whose files the raw store did not confirm: not settled, fetched again on the next run. */
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
    mode, stopped: 'done', items: 0, planned: 0, fetched: 0, stored: 0, gone: 0, oversize: 0, skippedTooLarge: 0, skippedNotImage: 0, blocked: 0, trouble: 0,
    skippedLedger: 0, notAllowedHost: 0, badLines: 0, entriesCapped: 0, itemsWithFailures: 0,
  };
  const started = deps.now();
  const allowed = compileAllowed(opts.allowedHosts);
  const outcome = createOutcomeMemory(opts.outcomeMemory ?? DEFAULT_OUTCOME_MEMORY); // what the store CONFIRMED for a url in this run
  const count = (v: StoreVerdict): void => { if (v === 'stored') report.stored++; else if (v === 'too_large') report.skippedTooLarge++; else report.skippedNotImage++; };
  const sourceClass: SourceClass = opts.sourceClass ?? 'unknown';
  const budget = opts.probe ?? opts.maxFiles;

  const lane = deps.hook.stats();
  if (!lane.enabled) {
    return { ...report, stopped: 'refused', refusal: `the image capture lane is off${lane.reason ? ` (${lane.reason})` : ''}; refusing to fetch what would be dropped` };
  }
  if (mode !== 'dry-run' && deps.sink === undefined) {
    return { ...report, stopped: 'refused', refusal: 'the raw store sink cannot confirm a write; refusing to settle files it has not stored' };
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
  const interrupted = (): boolean => opts.signal?.aborted === true;
  const onAbort = (): void => deps.observer.stop('interrupted by a signal');
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for await (const entry of deps.items) {
      if (!entry.ok) { report.badLines++; continue; }
      const item = entry.item;
      const itemKey = `${item.site}/${item.itemId}`;
      if (interrupted()) { report.stopped = 'interrupted'; exhausted = false; break; }
      if (opts.maxMs !== undefined && deps.now() - started >= opts.maxMs) { report.stopped = 'time'; exhausted = false; break; }
      if (budget !== undefined && report.planned >= budget) { report.stopped = 'limit'; exhausted = false; break; }
      if (!preflighted) {
        const problem = preflight(deps.policy, item.pageUrl, allowedHostnames(opts.allowedHosts));
        if (problem !== undefined) return { ...report, stopped: 'refused', refusal: problem };
        preflighted = true;
      }
      if (entry.capped !== undefined && entry.capped > 0) {
        report.entriesCapped += entry.capped;
        deps.log(`[gallery] ${itemKey}: ${entry.capped} entries over the ${item.entries.length} cap left out`);
      }

      // the url every comparison uses: the canonical spelling, whatever a feed handed over
      const wanted = item.entries.flatMap(e => {
        const url = canonicalImageUrl(e.src);
        if (url === undefined || !originAllowed(url, allowed)) { report.notAllowedHost++; return []; }
        if (deps.ledger.has(itemKey, url)) { report.skippedLedger++; return []; }
        return [{ ...e, src: url }];
      });
      const room = budget === undefined ? wanted.length : Math.max(0, budget - report.planned);
      const todo = wanted.slice(0, room);
      if (todo.length === 0) continue;
      report.items++;
      report.planned += todo.length;
      if (mode === 'dry-run') continue;

      const before = deps.hook.stats();
      const sinkBefore = deps.sink?.stats();
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
      // The put runs on the sink's workers after capture() has returned: wait for every one of this item's before any of its files
      // is settled, so a put that fails (or a process that dies) leaves the file unsettled and fetched again, never lost.
      if (deps.sink !== undefined) await deps.sink.flush();
      const after = deps.hook.stats();
      const sinkAfter = deps.sink?.stats();
      const obs = deps.observer.take();

      // `failed` also counts fetch faults the observations already account for; what is left is the sink losing bytes
      // we did fetch. Such an item is re-driven whole rather than settled, so a stored-but-lost file is never forgotten.
      const accounted = obs.filter(o => !o.ok && (o.reason === 'http-status' || o.reason === 'timeout' || o.reason === 'threw')).length;
      // The store SKIPS some bodies and still calls them admitted. It checks, in this order: empty, over its ceiling, not JPEG/PNG/GIF/WebP/AVIF
      // by magic bytes. The fetched sizes and the observer's sniff (the sink's own function) say which of this item's files it skipped and why,
      // so each is settled by its own verdict. A skip the fetched bodies do not account for (the lane off, or more skips than bodies that
      // qualify) is bytes that are not at rest and is treated as a lost put. The hook may send a body only once (same bytes under two urls),
      // so the sink counting FEWER skips than there are qualifying bodies is fine.
      const storeCap = opts.storeMaxBytes;
      const verdictOf = (o: FetchObservation): StoreVerdict => {
        if (o.bytes === 0) return 'not_image';
        if (storeCap !== undefined && o.bytes !== undefined && o.bytes > storeCap) return 'too_large';
        return o.notImage === true ? 'not_image' : 'stored';
      };
      const fetchedOk = obs.filter(o => o.ok);
      const sizeSkips = fetchedOk.filter(o => verdictOf(o) === 'too_large').length;
      const typeSkips = fetchedOk.filter(o => verdictOf(o) === 'not_image').length;
      const delta = (k: 'tooLarge' | 'notImage' | 'empty' | 'disabled'): number => skippedOf(sinkAfter, k) - skippedOf(sinkBefore, k);
      const unexplainedSkip = delta('disabled') > 0 || delta('tooLarge') > sizeSkips || delta('notImage') + delta('empty') > typeSkips;
      const sinkLost = after.failed - before.failed - accounted > 0
        || (sinkAfter !== undefined && sinkBefore !== undefined && lossOf(sinkAfter) > lossOf(sinkBefore))
        || unexplainedSkip;
      if (sinkLost) report.itemsWithFailures++;

      const observed = new Set<string>();
      for (const o of obs) {
        report.fetched++;
        const url = canonicalImageUrl(o.url) ?? o.url;
        observed.add(url);
        const c = classifyObservation(o);
        if (c !== 'ok' && c !== 'notimage') report[c]++;
        const verdict = o.ok && !sinkLost ? verdictOf(o) : undefined;
        if (verdict !== undefined) {
          outcome.set(url, verdict);
          count(verdict);
        }
        if (mode === 'probe') { probeObservations.push(o); continue; }
        if (verdict !== undefined) deps.ledger.settle(itemKey, url, SETTLED_AS[verdict]);
        else if (c === 'gone') deps.ledger.settle(itemKey, url, 'gone');
        else if (c === 'oversize') deps.ledger.settle(itemKey, url, 'oversize');
      }
      // Bytes the store lost are not at rest, whatever the hook's memo was told when it admitted them: take the urls out of it, so a
      // later item sharing one fetches it itself (and the store is asked again) rather than being told it is stored.
      if (sinkLost) deps.hook.forget?.([...observed]);

      // A file this item lists that no fetch was made for, because the hook already held its bytes from another item (a MEMO hit:
      // no request, but this item's own depiction is reported). Only when the memo explains every unfetched file and nothing else
      // was skipped is it settled, and then only for a file whose put THIS run saw the store confirm; a memo hit nothing confirmed is a
      // failure (unsettled, fetched again next run). A file left out for any other reason stays unsettled and is planned again.
      if (mode !== 'probe' && !sinkLost) {
        const unfetched = todo.filter(e => !observed.has(e.src));
        const skips = (counts: object): Array<[string, number]> => Object.entries(counts).map(([k, v]) => [k, typeof v === 'number' ? v : 0]);
        const was = new Map(skips(before.skipped));
        const delta = (k: string, v: number): number => v - (was.get(k) ?? 0);
        const memoHits = skips(after.skipped).filter(([k]) => k === 'memo').reduce((n, [k, v]) => n + delta(k, v), 0);
        const otherSkips = skips(after.skipped).filter(([k]) => k !== 'memo').reduce((n, [k, v]) => n + delta(k, v), 0);
        if (unfetched.length > 0 && memoHits === unfetched.length && otherSkips === 0) {
          let unconfirmed = 0;
          for (const e of unfetched) {
            const known = outcome.get(e.src);
            if (known === undefined) { unconfirmed++; continue; }
            deps.ledger.settle(itemKey, e.src, SETTLED_AS[known]);
            count(known);
          }
          if (unconfirmed > 0) report.itemsWithFailures++;
        }
      }
      deps.log(`[gallery] ${itemKey}: ${obs.length} fetched, ${report.stored} stored so far, ${report.blocked} blocked`);

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
      if (interrupted()) { report.stopped = 'interrupted'; exhausted = false; break; }
      if (mode !== 'probe' && opts.maxFiles !== undefined && report.fetched >= opts.maxFiles) { report.stopped = 'limit'; exhausted = false; break; }
      if (mode === 'probe' && report.fetched >= (opts.probe ?? 0)) { report.stopped = 'limit'; exhausted = false; break; }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (mode === 'probe') {
    const judged = judgeProbe({ observations: probeObservations, requests: deps.requests(), allowedHosts: opts.allowedHosts, wanted: opts.probe ?? 0, exhausted });
    // A probe puts its files through the real sink. Whatever the store did not keep is evidence the host's answers cannot be stored as they are,
    // so the verdict cannot be a PASS (and the exit code, which follows the verdict, cannot be 0).
    const storeProblems = [
      ...(report.itemsWithFailures > 0 ? [`the store did not confirm the files of ${report.itemsWithFailures} item(s)`] : []),
      ...(report.skippedTooLarge > 0 ? [`the store skipped ${report.skippedTooLarge} file(s) as over its size ceiling`] : []),
      ...(report.skippedNotImage > 0 ? [`the store skipped ${report.skippedNotImage} file(s) as not an image`] : []),
    ];
    report.probe = storeProblems.length === 0 ? judged : { ...judged, verdict: 'FAIL', reasons: [...judged.reasons, ...storeProblems] };
  }
  return report;
}
