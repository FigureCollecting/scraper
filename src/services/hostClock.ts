/**
 * hostClock — ONE dispatch clock per host, shared by the lanes that reach a store's own host.
 *
 * Without it every lane keeps its own per-host clock: the queue's record dispatch a private map, the
 * image bytes lane a HostRateLimiter with the limiter's DEFAULT config. So on a store that serves
 * some plates off its own main host (as a page-level route, not a CDN) a record and an image could
 * leave back to back, and after ~18 clean image GETs the image gap alone recovered to 274 ms while
 * that store's records were 7 s apart (Ross QB-4 "yes", 2026-10-04; plan-v3 QB-U30a, the queue and
 * image half of design.host_clock). On a host this clock covers, both lanes book here, and no
 * request leaves less than a floor after the previous one, whichever lane sent it.
 *
 * Two ways to book, one per kind of caller:
 *   - {@link HostClock.tryAcquire} for the queue, which never blocks: grant now (and book it) or say
 *     how long to wait, booking nothing — a paced item is skipped exactly as before.
 *   - {@link HostClock.reserve} for a caller that waits (image bytes): the earliest slot is booked AT
 *     ONCE, so the queue sees it while the image is still asleep, and the caller sleeps until it.
 *
 * SEND TIME, not booking time (plan-v3 rev 6): a booking says when a request MAY go; MFC sees when it
 * DOES go, and a late timer or a busy event loop can put the two far apart. So every caller, in ONE
 * synchronous step immediately before it hands the request to its transport, asks
 * {@link HostClock.msUntilSendable} (0 = go; otherwise it waits and asks again, booking again if its
 * slot has passed) and then {@link HostClock.settle}s: the clock keeps the host's last real send and
 * spaces every later booking and send a full floor from it. Nothing can then leave while
 * `now < lastSentAt + floor`, however late a timer fires.
 *
 * Scope is `SCRAPE_HOST_CLOCK`: unset / `off` (the default) = no host, so every lane paces exactly as
 * it did; `all` = every host; otherwise a comma-separated list of hosts. A host is matched exactly
 * after normalising (case, `www.`, trailing dot), so `example.com` does NOT pull in a
 * `static.example.com` image CDN. A listed entry that is not a bare hostname (a URL, a path, a port),
 * and `off` / `all` inside a list, are ignored, each with a boot WARN ({@link HostClock.warnings}).
 *
 * The floor: the queue passes its own per-host floor rule (`hostBaseDelayMs`) on every call. A
 * waiting caller does not own that rule, so it asks {@link HostClock.floorFor}, which answers from a
 * floor source the composition root binds (the queue's rule again) and only for a host the source
 * knows as a STORE's host; a CDN gets no floor and stays on its own limiter. Each booking and each
 * send remembers its floor and the next request keeps the larger, so the floor holds even if two
 * callers were ever to disagree.
 *
 * The SEND-TIME OBSERVER (design.host_clock.observe): every wired caller also reports the same send
 * instant to {@link HostClock.recordSend}, for every store host and whatever the scope says, so the
 * clock-off reading is the live negative control. /health/detailed shows the trailing hour per host
 * ({@link HostClock.view}) and a summary line is logged every 10 minutes ({@link startHostClockSummary}).
 *
 * In memory, per process: one scraper replica serves the queue and the image lane, so one clock is
 * the fleet's. A restart starts with an empty clock (the first request on each host goes at once),
 * exactly as the queue's private map always has.
 *
 * QB-U30b (plan-v3 rev 7) puts every other caller of a store's main host on the same clock through
 * hostClockSend.ts (the /catalog listing, seed and rotating fetches, POST /resolve, the legacy /scrape
 * route, /lookup, fetchBody follow-ups, a transport's session prime and the plugin-mounted routes) and
 * adds, keeping every QB-U30a name and signature:
 *   - DISPATCH JITTER: `SCRAPE_DISPATCH_JITTER_MS` (host=ms csv, default 0). Each send stamped on a
 *     clocked host draws floor(rand x J) from the host's (host, 'jitter') stream of the process seed
 *     and keeps it on the stamp, so the next request leaves floor + that jitter after the real send,
 *     whichever caller sent it and however late (J = 0 draws nothing). Drawn at SEND time, not at
 *     booking time: a sender's stamp is the one place every caller passes, so a late hand-off can
 *     never lose its slot's jitter.
 *   - The blocking caller's WAIT CAP floor + J + `SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS` (3000): a
 *     reservation past it is refused (no booking). A host whose floor + J exceeds the ceiling
 *     CATALOG_STORE_TIMEOUT_MS - slack - `SCRAPE_CATALOG_MIN_FETCH_MS` (27 s at the deployed 60 s) is
 *     not waited for by blocking callers; their sends are RECORDED instead ({@link HostClock.record}).
 *   - the WAIT RULE's lost-slot gate ({@link HostClock.sendWait}), the after-invoke stamp
 *     ({@link HostClock.markSent}), and the observer's other callers, constrained gaps, refusals and
 *     the listing p99 / /lookup p95 inputs (AC-R1, AC-R2).
 *   - the `all,-host[,-host...]` scope form, through the grammar SCRAPE_POOL_SELECT shares (hostSelect).
 */
import { resolveCatalogStoreTimeoutMs } from '../driver/catalogStoreTimeout.js';
import { deriveStream, type Rng } from './poolSelect.js';
import { getProcessSeed } from './processSeed.js';
import { isBareHostname, normalizeSelectHost, parseHostSelect, type HostSelect, type HostSelectMode } from './hostSelect.js';

/** Env var naming the hosts on the shared clock: `off` (default) | `all` | `all,-host,...` | `host,host,...`. */
export const HOST_CLOCK_ENV = 'SCRAPE_HOST_CLOCK';

/** Env var: per-host dispatch jitter J in ms, `host=ms,host=ms` (default 0 = none). */
export const JITTER_ENV = 'SCRAPE_DISPATCH_JITTER_MS';

/** Env var: the slack a blocking caller may wait beyond floor + J (default 3000 ms). */
export const WAIT_SLACK_ENV = 'SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS';

/** Env var: the fetch time a blocking caller must keep from its budget after the wait (default 30000 ms). */
export const MIN_FETCH_ENV = 'SCRAPE_CATALOG_MIN_FETCH_MS';

const DEFAULT_WAIT_SLACK_MS = 3000;
const DEFAULT_MIN_FETCH_MS = 30_000;
/** The budget a blocking caller's wait and fetch share when none is given: the deployed CATALOG_STORE_TIMEOUT_MS. */
const DEFAULT_BLOCKING_BUDGET_MS = 60_000;
/** The largest jitter a host may declare. */
const MAX_JITTER_MS = 60_000;

/** The observer's window: the block and the summary line cover the trailing hour. */
export const HOST_CLOCK_WINDOW_MS = 60 * 60_000;

/** How often {@link startHostClockSummary} logs the per-host summary lines. */
export const HOST_CLOCK_SUMMARY_INTERVAL_MS = 10 * 60_000;

/** Host key: trimmed, lowercased, trailing root dots and a leading `www.` stripped. */
export function normalizeClockHost(host: string): string {
  return normalizeSelectHost(host);
}

/**
 * `SCRAPE_HOST_CLOCK`'s raw value read once through the grammar it shares with SCRAPE_POOL_SELECT
 * (hostSelect): QB-U30a's lenient host list, plus the strict `all,-host` exclusion form.
 */
function readScope(raw: string | undefined): HostSelect {
  return parseHostSelect(raw, { envName: HOST_CLOCK_ENV, tag: '[HOST-CLOCK]', listEntries: 'ignore' });
}

/** Which hosts are on the shared clock, from `SCRAPE_HOST_CLOCK`'s raw value (answered per call). */
export function parseHostClockScope(raw: string | undefined): (host: string) => boolean {
  const scope = readScope(raw);
  if (scope.mode === 'all') return () => true;
  if (scope.mode === 'all-except') {
    const excluded = new Set(scope.excluded);
    return host => !excluded.has(normalizeClockHost(host));
  }
  const hosts = new Set(scope.hosts);
  return host => hosts.has(normalizeClockHost(host));
}

/** `SCRAPE_DISPATCH_JITTER_MS` read: J per normalised host, and one WARN per entry ignored. */
export interface JitterConfig {
  byHost: Map<string, number>;
  warnings: string[];
}

/** Parse `host=ms[,host=ms...]`; blanks, `off` and a lone `0` mean no jitter anywhere. */
export function parseJitterMs(raw: string | undefined): JitterConfig {
  const byHost = new Map<string, number>();
  const warnings: string[] = [];
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'off' || value === '0') return { byHost, warnings };
  const warn = (entry: string, why: string) => warnings.push(`[HOST-CLOCK] WARN ${JITTER_ENV} entry "${entry}" ${why}; ignored`);
  for (const entry of value.split(',').map(part => part.trim())) {
    if (entry === '') continue;
    const eq = entry.lastIndexOf('=');
    if (eq < 0) {
      warn(entry, 'is not host=ms');
      continue;
    }
    const host = normalizeClockHost(entry.slice(0, eq));
    const msText = entry.slice(eq + 1).trim();
    const ms = Number(msText);
    if (!isBareHostname(host)) warn(entry, 'is not a bare hostname');
    else if (msText === '' || !Number.isInteger(ms) || ms < 0 || ms > MAX_JITTER_MS) warn(entry, `is not a whole number of ms in [0, ${MAX_JITTER_MS}]`);
    else byHost.set(host, ms);
  }
  return { byHost, warnings };
}

/** A non-negative whole number of ms from the environment, else the default. */
function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Resolves a host to its store's floor (ms), or undefined for a host no store declares. */
export type HostFloorSource = (host: string) => number | undefined;

/** A booked slot or a real send on a host: when, and the floor the next request keeps from it. */
interface Stamp {
  at: number;
  floorMs: number;
}

/**
 * The lane that handed a request to the transport: the queue's record dispatch and main-host images
 * (QB-U30a), and every caller QB-U30b wires (design.host_clock.callers).
 */
export type HostClockCaller =
  | 'queue'
  | 'image'
  | 'catalogListing'
  | 'catalogSeed'
  | 'catalogRotating'
  | 'resolve'
  | 'scrape'
  | 'lookup'
  | 'fetchBody'
  | 'sessionPrime'
  | 'pluginRoute';

/** Every caller, in the order the hostClock block lists them. */
export const HOST_CLOCK_CALLERS: readonly HostClockCaller[] = Object.freeze([
  'queue',
  'image',
  'catalogListing',
  'catalogSeed',
  'catalogRotating',
  'resolve',
  'scrape',
  'lookup',
  'fetchBody',
  'sessionPrime',
  'pluginRoute',
]);

/** Which latency percentile a blocking caller feeds: the per-store listing p99 (AC-R1) or the /lookup p95 (AC-R2). */
export type HostClockLatencyKind = 'listing' | 'lookup';

/**
 * How a BLOCKING caller treats a host (design.host_clock.wait_cap):
 *   - `clocked`: on the clock with a store floor and floor + J within the ceiling: reserve, wait, send;
 *   - `recorded`: on the clock but above the ceiling: send at once and record the send on the clock;
 *   - `off`: not on the clock (out of scope, or no store floor): send at once, observer only.
 */
export type BlockingRole = 'clocked' | 'recorded' | 'off';

/** QB-U30b settings; every one is optional and defaults to "as QB-U30a" (no jitter). */
export interface HostClockOptions {
  /** J (ms) for a normalised host; default 0 for every host. */
  jitterMs?: (host: string) => number;
  /** The stream a host's jitter is drawn from; default deriveStream(seed, host, 'jitter'). */
  jitterRng?: (host: string) => Rng;
  /** The seed the default streams derive from (logged at boot); default the process seed. */
  seed?: number;
  /** SCRAPE_CATALOG_CLOCK_WAIT_SLACK_MS; default 3000. */
  waitSlackMs?: number;
  /** SCRAPE_CATALOG_MIN_FETCH_MS; default 30000. */
  minFetchMs?: number;
  /** The budget a blocking caller's wait and fetch share (CATALOG_STORE_TIMEOUT_MS); default 60000. */
  blockingBudgetMs?: number;
  /** Boot WARNs from reading the options (an ignored jitter entry), returned by {@link HostClock.warnings}. */
  warnings?: string[];
}

/** One store host in /health/detailed's hostClock block: its sends in the trailing 60 minutes. */
export interface HostClockHostView {
  host: string;
  /** The floor source's floor for the host (read whatever the scope says). */
  floorMs: number;
  /** Whether the host is on the clock (in SCRAPE_HOST_CLOCK's scope). */
  clocked: boolean;
  sends60m: Record<HostClockCaller, number>;
  /** The smallest gap between two consecutive sends of the host, any callers; 0 with no gap yet. */
  minGapMs60m: number;
  /** How many of those gaps were under floorMs. */
  underFloor60m: number;
  /**
   * Gaps of CONSTRAINED sends: a send made after some caller had to wait for the host's clock since
   * the previous send (a refused tryAcquire, a reservation in the future, or a closed gate).
   */
  constrainedGaps60m: number;
  /** Their mean (ms, rounded), 0 with none: ~floor + J/2 while the clock binds. */
  meanConstrainedGapMs60m: number;
  /** Blocking reservations refused past the wait cap, per caller. */
  clockRefusals60m: Record<HostClockCaller, number>;
  /** p99 (nearest rank) of the /catalog listing fetches' wait + fetch time, 0 with none (AC-R1). */
  listingFetchP99Ms60m: number;
  /** p95 (nearest rank) of the /lookup store fetches' wait + fetch time, 0 with none (AC-R2). */
  lookupP95Ms60m: number;
  /** ISO time of the host's last send, null if it never sent. */
  lastSendAt: string | null;
}

/** /health/detailed's hostClock block. */
export interface HostClockView {
  mode: HostSelectMode;
  hosts: HostClockHostView[];
}

/** One observed send: when, which lane, the gap to the host's previous send (none for the first), and whether it waited for the clock. */
interface ObservedSend {
  at: number;
  caller: HostClockCaller;
  gapMs: number | undefined;
  constrained: boolean;
}

/** One refused reservation, or one latency sample. */
interface Noted<T> {
  at: number;
  value: T;
}

/** Zero for every caller. */
function perCaller(): Record<HostClockCaller, number> {
  return Object.fromEntries(HOST_CLOCK_CALLERS.map(caller => [caller, 0])) as Record<HostClockCaller, number>;
}

/** Nearest-rank percentile of the samples (0 with none). */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

/** Drop the entries older than the window from the front of a time-ordered log. */
function trim<T extends { at: number }>(log: T[], now: number): void {
  while (log.length > 0 && now - log[0].at >= HOST_CLOCK_WINDOW_MS) log.shift();
}

export class HostClock {
  private readonly bookings = new Map<string, Stamp>();
  private readonly sends = new Map<string, Stamp>();
  private readonly observed = new Map<string, ObservedSend[]>();
  private readonly lastObserved = new Map<string, number>();
  /** Hosts on which some caller had to wait for the clock since the host's last observed send. */
  private readonly waited = new Set<string>();
  private readonly refusals = new Map<string, Noted<HostClockCaller>[]>();
  private readonly latencies = new Map<string, Record<HostClockLatencyKind, Noted<number>[]>>();
  private readonly streams = new Map<string, Rng>();
  private readonly scope: HostSelect;
  private floorSource: HostFloorSource | null = null;

  /**
   * @param inScope  which hosts this clock covers (see {@link parseHostClockScope}).
   * @param rawScope the scope as configured, for {@link describe}, {@link warnings} and the view's mode.
   * @param options  QB-U30b's jitter, wait cap and ceiling (see {@link HostClockOptions}).
   */
  constructor(
    private readonly inScopeFn: (host: string) => boolean,
    private readonly rawScope: string = 'off',
    private readonly options: HostClockOptions = {},
  ) {
    this.scope = readScope(rawScope);
  }

  /** Whether the configured scope names any host (SCRAPE_HOST_CLOCK is not off). */
  isOn(): boolean {
    return this.scope.mode !== 'off';
  }

  /** Whether the host is on the shared clock. */
  inScope(host: string): boolean {
    return this.inScopeFn(normalizeClockHost(host));
  }

  /** Bind (or with `null`, unbind) the floor source waiting callers are paced by. */
  setFloorSource(source: HostFloorSource | null): void {
    this.floorSource = source;
  }

  /**
   * The floor a WAITING caller paces this host by: defined only for an in-scope host that the bound
   * source knows as a store's host. Undefined means "not on the clock for you": keep your own pacing.
   */
  floorFor(host: string): number | undefined {
    if (!this.floorSource || !this.inScope(host)) return undefined;
    return this.floorSource(normalizeClockHost(host));
  }

  /** When a request with this floor may follow a stamp: at least the larger of the two floors later. */
  private static after(stamp: Stamp | undefined, floorMs: number): number {
    return stamp === undefined ? -Infinity : stamp.at + Math.max(stamp.floorMs, floorMs);
  }

  /** The earliest time a booking with this floor may take: after the latest booking AND the last send. */
  private earliest(key: string, floorMs: number): number {
    return Math.max(HostClock.after(this.bookings.get(key), floorMs), HostClock.after(this.sends.get(key), floorMs));
  }

  /**
   * Non-blocking: book `now` and return 0 when the floor has passed since the host's latest booking
   * and its last send, otherwise return the ms still to wait and book nothing.
   */
  tryAcquire(host: string, now: number, floorMs: number): number {
    const key = normalizeClockHost(host);
    const remaining = this.earliest(key, floorMs) - now;
    if (remaining > 0) {
      this.waited.add(key);
      return remaining;
    }
    this.bookings.set(key, { at: now, floorMs });
    return 0;
  }

  /**
   * Blocking callers: book the earliest slot at or after `at` and return its time. The booking is
   * made now, so any caller asking before that time already sees it. With `capMs` (QB-U30b, the
   * blocking caller's wait cap) a slot more than `capMs` after `at` is REFUSED: null, nothing booked.
   */
  reserve(host: string, at: number, floorMs: number): number;
  reserve(host: string, at: number, floorMs: number, capMs: number): number | null;
  reserve(host: string, at: number, floorMs: number, capMs?: number): number | null {
    const key = normalizeClockHost(host);
    const readyAt = this.nextSlot(key, at, floorMs);
    if (capMs !== undefined && readyAt - at > capMs) return null;
    if (readyAt > at) this.waited.add(key);
    this.bookings.set(key, { at: readyAt, floorMs });
    return readyAt;
  }

  /** The slot {@link reserve} would book at `at`, booking nothing. */
  nextSlot(host: string, at: number, floorMs: number): number {
    return Math.max(at, this.earliest(normalizeClockHost(host), floorMs));
  }

  /**
   * THE SEND-TIME GATE: the ms before a caller holding `slot` (the time tryAcquire granted or reserve
   * returned) may hand its request to the transport at `now` — 0 = send now. It waits for its own
   * slot (an early timer) and for a full floor after the host's last real send (another caller sent
   * meanwhile). A caller that gets 0 must {@link settle} in the same synchronous step, before any
   * await, so no other request can slip in between the check and the send.
   */
  msUntilSendable(host: string, slot: number, now: number, floorMs: number): number {
    const key = normalizeClockHost(host);
    const openAt = Math.max(slot, HostClock.after(this.sends.get(key), floorMs));
    if (now < openAt) {
      this.waited.add(key);
      return openAt - now;
    }
    return 0;
  }

  /**
   * THE WAIT RULE's gate (QB-U30b, plan-v3 rev 7): null when the slot is LOST, i.e. the host has no
   * booking, or its latest booking is another one that is already due (the waiter slept through and
   * another caller took the host): re-book. Otherwise {@link msUntilSendable}: a valid slot whose
   * gate another caller's late send pushed out sleeps the remainder and is NOT re-booked (re-booking
   * would burn a full floor).
   */
  sendWait(host: string, slot: number, now: number, floorMs: number): number | null {
    const latest = this.bookings.get(normalizeClockHost(host));
    if (latest === undefined || (latest.at !== slot && latest.at <= now)) return null;
    return this.msUntilSendable(host, slot, now, floorMs);
  }

  /**
   * Stamp the instant a request REALLY leaves for the host. The next booking and the next send are
   * spaced from it; it never moves them earlier (RECORD RULE: the next allowed time is the later of
   * the latest booking's end and `sentAt + floor`, and an older stamp never replaces a newer one).
   * `floorMs` defaults to the floor of the host's latest booking (0 if it has none).
   */
  settle(host: string, sentAt: number, floorMs?: number): void {
    const key = normalizeClockHost(host);
    const floor = floorMs ?? this.bookings.get(key)?.floorMs ?? 0;
    const last = this.sends.get(key);
    if (last !== undefined && (last.at > sentAt || (last.at === sentAt && last.floorMs >= floor))) return;
    // QB-U30b: a new send draws its jitter, which spaces the next request with the floor. A send that
    // did not pass the gate (record) can land within the last send's jitter: the next allowed time
    // then stays the last send's, never earlier (RECORD RULE).
    const spacing = floor + this.drawJitter(key);
    this.sends.set(key, { at: sentAt, floorMs: last === undefined ? spacing : Math.max(spacing, last.at + last.floorMs - sentAt) });
  }

  /**
   * The after-invoke stamp (rev 7 SEND BLOCK): the transport of the send settled just before was
   * invoked at `sentAt`, so the host's last send moves to that instant, keeping its floor and jitter
   * and never moving earlier. Records nothing in the observer (the caller does, with recordSend).
   */
  markSent(host: string, sentAt: number): void {
    const key = normalizeClockHost(host);
    const last = this.sends.get(key);
    if (last !== undefined && last.at < sentAt) this.sends.set(key, { at: sentAt, floorMs: last.floorMs });
  }

  /**
   * A send that did NOT pass the gate (a blocking caller on a host above the ceiling): stamped on the
   * clock like a settle, under the RECORD RULE (the next allowed time never moves earlier) and with its
   * own jitter, so the queue's next record waits a full floor after it; and reported to the observer.
   * `floorMs` defaults to the store's floor ({@link floorFor}). A host off the clock: observer only.
   */
  record(host: string, sentAt: number, caller: HostClockCaller, floorMs?: number): void {
    const floor = floorMs ?? this.floorFor(host);
    if (floor !== undefined) this.settle(host, sentAt, floor);
    this.recordSend(host, caller, sentAt);
  }

  /** J (ms) for the host: SCRAPE_DISPATCH_JITTER_MS, 0 when none is declared. */
  jitterMsFor(host: string): number {
    return this.options.jitterMs?.(normalizeClockHost(host)) ?? 0;
  }

  /** floor(rand x J) from the host's stream; J = 0 draws nothing. */
  private drawJitter(key: string): number {
    const j = this.jitterMsFor(key);
    if (j <= 0) return 0;
    let rng = this.streams.get(key);
    if (rng === undefined) {
      rng = this.options.jitterRng?.(key) ?? deriveStream(this.seed(), key, 'jitter');
      this.streams.set(key, rng);
    }
    return Math.floor(rng() * j);
  }

  private seed(): number {
    return this.options.seed ?? getProcessSeed();
  }

  /** The blocking caller's wait cap on a clocked store host: floor + J + slack; undefined off the clock. */
  capMsFor(host: string): number | undefined {
    const floor = this.floorFor(host);
    return floor === undefined ? undefined : floor + this.jitterMsFor(host) + (this.options.waitSlackMs ?? DEFAULT_WAIT_SLACK_MS);
  }

  /**
   * The largest floor + J a blocking caller waits for: budget - slack - min fetch (27000 at the
   * deployed 60 s). A caller with a budget of its own (/lookup: LOOKUP_STORE_TIMEOUT_MS) passes it and
   * the fetch time it must keep; the defaults are CATALOG_STORE_TIMEOUT_MS and SCRAPE_CATALOG_MIN_FETCH_MS.
   */
  ceilingMs(
    budgetMs: number = this.options.blockingBudgetMs ?? DEFAULT_BLOCKING_BUDGET_MS,
    minFetchMs: number = this.options.minFetchMs ?? DEFAULT_MIN_FETCH_MS,
  ): number {
    return budgetMs - (this.options.waitSlackMs ?? DEFAULT_WAIT_SLACK_MS) - minFetchMs;
  }

  /** How a blocking caller with this budget treats the host (see {@link BlockingRole}), answered per call. */
  blockingRole(host: string, budgetMs?: number, minFetchMs?: number): BlockingRole {
    const floor = this.floorFor(host);
    if (floor === undefined) return 'off';
    return floor + this.jitterMsFor(host) > this.ceilingMs(budgetMs, minFetchMs) ? 'recorded' : 'clocked';
  }

  /** A blocking reservation was refused past the cap: counted per host and caller (clockRefusals60m). */
  noteRefusal(host: string, caller: HostClockCaller, at: number): void {
    const key = normalizeClockHost(host);
    if (!this.isStoreHost(key)) return;
    const log = this.refusals.get(key) ?? [];
    log.push({ at, value: caller });
    trim(log, at);
    this.refusals.set(key, log);
  }

  /** One blocking caller's wait + fetch time on the host, for the listing p99 / /lookup p95. */
  noteLatency(host: string, kind: HostClockLatencyKind, ms: number, at: number): void {
    const key = normalizeClockHost(host);
    if (!this.isStoreHost(key)) return;
    const logs = this.latencies.get(key) ?? { listing: [], lookup: [] };
    logs[kind].push({ at, value: ms });
    trim(logs[kind], at);
    this.latencies.set(key, logs);
  }

  private isStoreHost(key: string): boolean {
    return this.floorSource !== null && this.floorSource(key) !== undefined;
  }

  /**
   * THE OBSERVER: a caller handed a request for `host` to its transport at `sentAt` (the instant it
   * settled, when the host is on the clock). Recorded only for a host the floor source knows as a
   * STORE's host, and whatever the scope says. Measurement only: nothing is paced by it.
   */
  recordSend(host: string, caller: HostClockCaller, sentAt: number): void {
    const key = normalizeClockHost(host);
    // A wait for the clock since the previous send makes THIS send a constrained one.
    const constrained = this.waited.delete(key);
    if (!this.isStoreHost(key)) return;
    const previous = this.lastObserved.get(key);
    const log = this.observed.get(key) ?? [];
    log.push({ at: sentAt, caller, gapMs: previous === undefined ? undefined : sentAt - previous, constrained });
    trim(log, sentAt);
    this.observed.set(key, log);
    this.lastObserved.set(key, sentAt);
  }

  /** One host's line of the block at `now`: the trailing hour of its observed sends. */
  private hostView(key: string, now: number): HostClockHostView {
    const floorMs = this.floorSource?.(key) ?? 0;
    const sends60m = perCaller();
    let minGapMs60m: number | undefined;
    let underFloor60m = 0;
    let constrainedGaps60m = 0;
    let constrainedSum = 0;
    const inWindow = (at: number) => now - at < HOST_CLOCK_WINDOW_MS;
    for (const send of this.observed.get(key) ?? []) {
      if (!inWindow(send.at)) continue;
      sends60m[send.caller] += 1;
      if (send.gapMs === undefined) continue;
      if (minGapMs60m === undefined || send.gapMs < minGapMs60m) minGapMs60m = send.gapMs;
      if (send.gapMs < floorMs) underFloor60m += 1;
      if (send.constrained) {
        constrainedGaps60m += 1;
        constrainedSum += send.gapMs;
      }
    }
    const clockRefusals60m = perCaller();
    for (const refusal of this.refusals.get(key) ?? []) if (inWindow(refusal.at)) clockRefusals60m[refusal.value] += 1;
    const samples = (kind: HostClockLatencyKind) => (this.latencies.get(key)?.[kind] ?? []).filter(s => inWindow(s.at)).map(s => s.value);
    const last = this.lastObserved.get(key);
    return {
      host: key,
      floorMs,
      clocked: this.inScope(key),
      sends60m,
      minGapMs60m: minGapMs60m ?? 0,
      underFloor60m,
      constrainedGaps60m,
      meanConstrainedGapMs60m: constrainedGaps60m === 0 ? 0 : Math.round(constrainedSum / constrainedGaps60m),
      clockRefusals60m,
      listingFetchP99Ms60m: percentile(samples('listing'), 0.99),
      lookupP95Ms60m: percentile(samples('lookup'), 0.95),
      lastSendAt: last === undefined ? null : new Date(last).toISOString(),
    };
  }

  /**
   * /health/detailed's hostClock block at `now`: every store host that sent, plus every listed host
   * the floor source knows (zeros while idle), sorted by host.
   */
  view(now: number): HostClockView {
    const keys = new Set([...this.lastObserved.keys(), ...this.refusals.keys(), ...this.latencies.keys()]);
    for (const host of this.scope.hosts) if (this.floorSource?.(host) !== undefined) keys.add(host);
    return { mode: this.scope.mode, hosts: [...keys].sort().map(key => this.hostView(key, now)) };
  }

  /** The 10-minute summary: one line per host with sends in the trailing hour, numbers as in the block. */
  summaryLines(now: number): string[] {
    const total = (host: HostClockHostView) => HOST_CLOCK_CALLERS.reduce((sum, caller) => sum + host.sends60m[caller], 0);
    return this.view(now).hosts
      .filter(host => total(host) > 0)
      .map(host => `[HOST-CLOCK] summary host=${host.host} sends=${total(host)} minGapMs=${host.minGapMs60m} underFloor=${host.underFloor60m}`);
  }

  /** One boot WARN line per listed entry the scope ignores (or one for a malformed value), and per jitter entry ignored. */
  warnings(): string[] {
    return [...this.scope.warnings, ...(this.options.warnings ?? [])];
  }

  /**
   * QB-U30b's boot lines for the given store hosts: the jitter per host with the process seed its
   * streams derive from, and every store host on the clock that blocking callers record instead of
   * waiting for (floor + J above the ceiling); given /lookup's budget, the same for /lookup's ceiling.
   */
  bootLines(storeHosts: string[], lookup?: { budgetMs: number; minFetchMs: number }): string[] {
    const hosts = [...new Set(storeHosts.map(normalizeClockHost))].sort();
    const jittered = hosts.filter(host => this.jitterMsFor(host) > 0);
    const jitterLine =
      jittered.length === 0
        ? `[HOST-CLOCK] jitter ${JITTER_ENV} off: every gap is the floor`
        : `[HOST-CLOCK] jitter ${JITTER_ENV}: ${jittered.map(host => `${host} 0-${this.jitterMsFor(host) - 1} ms`).join(', ')}; process seed ${this.seed()}, one stream per (host, 'jitter')`;
    const recorded = (budgetMs?: number, minFetchMs?: number) => {
      const named = hosts.filter(host => this.blockingRole(host, budgetMs, minFetchMs) === 'recorded').map(host => `${host} (floor ${this.floorFor(host)} ms)`);
      return named.length === 0 ? 'none' : named.join(', ');
    };
    const slack = this.options.waitSlackMs ?? DEFAULT_WAIT_SLACK_MS;
    const lines = [
      jitterLine,
      `[HOST-CLOCK] blocking callers wait at most floor + jitter + ${slack} ms; hosts above the ${this.ceilingMs()} ms ceiling are recorded only: ${recorded()}`,
    ];
    if (lookup) {
      lines.push(
        `[HOST-CLOCK] /lookup (budget ${lookup.budgetMs} ms, min fetch ${lookup.minFetchMs} ms) waits only where floor + jitter <= ${this.ceilingMs(lookup.budgetMs, lookup.minFetchMs)} ms; recorded only: ${recorded(lookup.budgetMs, lookup.minFetchMs)}`,
      );
    }
    return lines;
  }

  /** One boot log line: what the clock covers and, per listed host, the floor its images get. */
  describe(): string {
    if (this.scope.mode === 'off') {
      return `[HOST-CLOCK] ${HOST_CLOCK_ENV} off: every host keeps its own lane pacing`;
    }
    const head = `[HOST-CLOCK] ${HOST_CLOCK_ENV}=${this.rawScope.trim()}: one clock per host for queue dispatch and main-host images`;
    if (this.scope.mode === 'all') return head;
    if (this.scope.mode === 'all-except') return `${head}; except ${this.scope.excluded.join(', ')}`;
    const floors = this.scope.hosts.map(host => {
      const floor = this.floorFor(host);
      return floor === undefined ? `${host} no store floor (queue only)` : `${host} floor ${floor} ms`;
    });
    return `${head}; ${floors.join(', ')}`;
  }
}

/**
 * Log the clock's summary lines every {@link HOST_CLOCK_SUMMARY_INTERVAL_MS} (an unref'd timer, so
 * it never holds the process open). Returns the stop function.
 */
export function startHostClockSummary(
  clock: HostClock,
  log: (line: string) => void = console.log,
  now: () => number = Date.now,
): () => void {
  const timer = setInterval(() => {
    for (const line of clock.summaryLines(now())) log(line);
  }, HOST_CLOCK_SUMMARY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

let shared: HostClock | undefined;

/**
 * The process clock, read from the environment once, at first use: the scope (`SCRAPE_HOST_CLOCK`),
 * the jitter (`SCRAPE_DISPATCH_JITTER_MS`, streams from the process seed), the wait slack and the min
 * fetch time, and the budget they share (`CATALOG_STORE_TIMEOUT_MS`, resolved like the catalog's).
 */
export function getHostClock(): HostClock {
  if (!shared) {
    const env = process.env;
    const raw = env[HOST_CLOCK_ENV] ?? 'off';
    const jitter = parseJitterMs(env[JITTER_ENV]);
    shared = new HostClock(parseHostClockScope(raw), raw, {
      jitterMs: host => jitter.byHost.get(host) ?? 0,
      waitSlackMs: envMs(env, WAIT_SLACK_ENV, DEFAULT_WAIT_SLACK_MS),
      minFetchMs: envMs(env, MIN_FETCH_ENV, DEFAULT_MIN_FETCH_MS),
      blockingBudgetMs: resolveCatalogStoreTimeoutMs(env),
      warnings: jitter.warnings,
    });
  }
  return shared;
}

/** Test seam: replace (or with `null`, forget) the process clock. */
export function setHostClock(clock: HostClock | null): void {
  shared = clock ?? undefined;
}
