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
 */

/** Env var naming the hosts on the shared clock: `off` (default) | `all` | `host,host,...`. */
export const HOST_CLOCK_ENV = 'SCRAPE_HOST_CLOCK';

/** The observer's window: the block and the summary line cover the trailing hour. */
export const HOST_CLOCK_WINDOW_MS = 60 * 60_000;

/** How often {@link startHostClockSummary} logs the per-host summary lines. */
export const HOST_CLOCK_SUMMARY_INTERVAL_MS = 10 * 60_000;

/** Host key: trimmed, lowercased, trailing root dots and a leading `www.` stripped. */
export function normalizeClockHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** One or more dot-separated labels of letters, digits and inner hyphens: no scheme, path or port. */
const BARE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

interface Scope {
  mode: 'off' | 'all' | 'hosts';
  hosts: string[];
  warnings: string[];
}

/** `SCRAPE_HOST_CLOCK`'s raw value read once: the mode, the hosts kept and a WARN per entry dropped. */
function readScope(raw: string | undefined): Scope {
  const value = (raw ?? '').trim();
  const keyword = value.toLowerCase();
  if (keyword === 'all') return { mode: 'all', hosts: [], warnings: [] };
  if (keyword === '' || keyword === 'off') return { mode: 'off', hosts: [], warnings: [] };
  const hosts: string[] = [];
  const warnings: string[] = [];
  for (const entry of value.split(',').map(part => part.trim())) {
    const host = normalizeClockHost(entry);
    if (host === '') continue;
    if (host === 'off' || host === 'all') {
      warnings.push(`[HOST-CLOCK] WARN ${HOST_CLOCK_ENV} entry "${entry}" is a keyword, not a host, inside a host list; ignored`);
    } else if (!BARE_HOSTNAME.test(host)) {
      warnings.push(`[HOST-CLOCK] WARN ${HOST_CLOCK_ENV} entry "${entry}" is not a bare hostname; ignored`);
    } else if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return { mode: hosts.length === 0 ? 'off' : 'hosts', hosts, warnings };
}

/** Which hosts are on the shared clock, from `SCRAPE_HOST_CLOCK`'s raw value. */
export function parseHostClockScope(raw: string | undefined): (host: string) => boolean {
  const scope = readScope(raw);
  if (scope.mode === 'all') return () => true;
  const hosts = new Set(scope.hosts);
  return host => hosts.has(normalizeClockHost(host));
}

/** Resolves a host to its store's floor (ms), or undefined for a host no store declares. */
export type HostFloorSource = (host: string) => number | undefined;

/** A booked slot or a real send on a host: when, and the floor the next request keeps from it. */
interface Stamp {
  at: number;
  floorMs: number;
}

/** The lane that handed a request to the transport (QB-U30b adds the other callers). */
export type HostClockCaller = 'queue' | 'image';

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
  /** ISO time of the host's last send, null if it never sent. */
  lastSendAt: string | null;
}

/** /health/detailed's hostClock block. */
export interface HostClockView {
  mode: 'off' | 'all' | 'hosts';
  hosts: HostClockHostView[];
}

/** One observed send: when, which lane, and the gap to the host's previous send (none for the first). */
interface ObservedSend {
  at: number;
  caller: HostClockCaller;
  gapMs: number | undefined;
}

export class HostClock {
  private readonly bookings = new Map<string, Stamp>();
  private readonly sends = new Map<string, Stamp>();
  private readonly observed = new Map<string, ObservedSend[]>();
  private readonly lastObserved = new Map<string, number>();
  private readonly scope: Scope;
  private floorSource: HostFloorSource | null = null;

  /**
   * @param inScope  which hosts this clock covers (see {@link parseHostClockScope}).
   * @param rawScope the scope as configured, for {@link describe}, {@link warnings} and the view's mode.
   */
  constructor(
    private readonly inScopeFn: (host: string) => boolean,
    private readonly rawScope: string = 'off',
  ) {
    this.scope = readScope(rawScope);
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
    if (remaining > 0) return remaining;
    this.bookings.set(key, { at: now, floorMs });
    return 0;
  }

  /**
   * Blocking callers: book the earliest slot at or after `at` and return its time. The booking is
   * made now, so any caller asking before that time already sees it.
   */
  reserve(host: string, at: number, floorMs: number): number {
    const key = normalizeClockHost(host);
    const readyAt = Math.max(at, this.earliest(key, floorMs));
    this.bookings.set(key, { at: readyAt, floorMs });
    return readyAt;
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
    return now < openAt ? openAt - now : 0;
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
    this.sends.set(key, { at: sentAt, floorMs: floor });
  }

  /**
   * THE OBSERVER: a caller handed a request for `host` to its transport at `sentAt` (the instant it
   * settled, when the host is on the clock). Recorded only for a host the floor source knows as a
   * STORE's host, and whatever the scope says. Measurement only: nothing is paced by it.
   */
  recordSend(host: string, caller: HostClockCaller, sentAt: number): void {
    const key = normalizeClockHost(host);
    if (!this.floorSource || this.floorSource(key) === undefined) return;
    const previous = this.lastObserved.get(key);
    const log = this.observed.get(key) ?? [];
    log.push({ at: sentAt, caller, gapMs: previous === undefined ? undefined : sentAt - previous });
    while (log.length > 0 && sentAt - log[0].at >= HOST_CLOCK_WINDOW_MS) log.shift();
    this.observed.set(key, log);
    this.lastObserved.set(key, sentAt);
  }

  /** One host's line of the block at `now`: the trailing hour of its observed sends. */
  private hostView(key: string, now: number): HostClockHostView {
    const floorMs = this.floorSource?.(key) ?? 0;
    const sends60m: Record<HostClockCaller, number> = { queue: 0, image: 0 };
    let minGapMs60m: number | undefined;
    let underFloor60m = 0;
    for (const send of this.observed.get(key) ?? []) {
      if (now - send.at >= HOST_CLOCK_WINDOW_MS) continue;
      sends60m[send.caller] += 1;
      if (send.gapMs === undefined) continue;
      if (minGapMs60m === undefined || send.gapMs < minGapMs60m) minGapMs60m = send.gapMs;
      if (send.gapMs < floorMs) underFloor60m += 1;
    }
    const last = this.lastObserved.get(key);
    return {
      host: key,
      floorMs,
      clocked: this.inScope(key),
      sends60m,
      minGapMs60m: minGapMs60m ?? 0,
      underFloor60m,
      lastSendAt: last === undefined ? null : new Date(last).toISOString(),
    };
  }

  /**
   * /health/detailed's hostClock block at `now`: every store host that sent, plus every listed host
   * the floor source knows (zeros while idle), sorted by host.
   */
  view(now: number): HostClockView {
    const keys = new Set(this.lastObserved.keys());
    for (const host of this.scope.hosts) if (this.floorSource?.(host) !== undefined) keys.add(host);
    return { mode: this.scope.mode, hosts: [...keys].sort().map(key => this.hostView(key, now)) };
  }

  /** The 10-minute summary: one line per host with sends in the trailing hour, numbers as in the block. */
  summaryLines(now: number): string[] {
    return this.view(now).hosts
      .filter(host => host.sends60m.queue + host.sends60m.image > 0)
      .map(host => `[HOST-CLOCK] summary host=${host.host} sends=${host.sends60m.queue + host.sends60m.image} minGapMs=${host.minGapMs60m} underFloor=${host.underFloor60m}`);
  }

  /** One boot WARN line per listed entry the scope ignores (not a bare hostname, or a keyword). */
  warnings(): string[] {
    return [...this.scope.warnings];
  }

  /** One boot log line: what the clock covers and, per listed host, the floor its images get. */
  describe(): string {
    if (this.scope.mode === 'off') {
      return `[HOST-CLOCK] ${HOST_CLOCK_ENV} off: every host keeps its own lane pacing`;
    }
    const head = `[HOST-CLOCK] ${HOST_CLOCK_ENV}=${this.rawScope.trim()}: one clock per host for queue dispatch and main-host images`;
    if (this.scope.mode === 'all') return head;
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

/** The process clock: scope read from `SCRAPE_HOST_CLOCK` once, at first use. */
export function getHostClock(): HostClock {
  if (!shared) {
    const raw = process.env[HOST_CLOCK_ENV] ?? 'off';
    shared = new HostClock(parseHostClockScope(raw), raw);
  }
  return shared;
}

/** Test seam: replace (or with `null`, forget) the process clock. */
export function setHostClock(clock: HostClock | null): void {
  shared = clock ?? undefined;
}
