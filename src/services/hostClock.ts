/**
 * hostClock — ONE dispatch clock per host, shared by the lanes that reach a store's own host.
 *
 * Without it every lane keeps its own per-host clock: the queue's record dispatch a private map, the
 * image bytes lane a HostRateLimiter with the limiter's DEFAULT config. So on a store that serves
 * some plates off its own main host (as a page-level route, not a CDN) a record and an image could
 * leave back to back, and after ~18 clean image GETs the image gap alone recovered to 274 ms while
 * that store's records were 7 s apart (Ross QB-4 "yes", 2026-10-04; plan-v3 QB-U8, the image half of
 * design.host_clock). On a host this clock covers, both lanes book here, and consecutive bookings
 * are at least a floor apart, whichever lane made them.
 *
 * Two ways to book, one per kind of caller:
 *   - {@link HostClock.tryAcquire} for the queue, which never blocks: grant now (and book it) or say
 *     how long to wait, booking nothing — a paced item is skipped exactly as before.
 *   - {@link HostClock.reserve} for a caller that waits (image bytes): the earliest slot is booked AT
 *     ONCE, so the queue sees it while the image is still asleep, and the caller sleeps until it.
 *
 * Scope is `SCRAPE_HOST_CLOCK`: unset / `off` (the default) = no host, so every lane paces exactly as
 * it did; `all` = every host; otherwise a comma-separated list of hosts. A host is matched exactly
 * after normalising (case, `www.`, trailing dot), so `example.com` does NOT pull in a
 * `static.example.com` image CDN.
 *
 * The floor: the queue passes its own per-host floor rule (`hostBaseDelayMs`) on every call. A
 * waiting caller does not own that rule, so it asks {@link HostClock.floorFor}, which answers from a
 * floor source the composition root binds (the queue's rule again) and only for a host the source
 * knows as a STORE's host; a CDN gets no floor and stays on its own limiter. Each booking remembers
 * its floor and the next one keeps the larger of the two, so the floor holds even if two callers
 * were ever to disagree.
 *
 * In memory, per process: one scraper replica serves the queue and the image lane, so one clock is
 * the fleet's. A restart starts with an empty clock (the first request on each host goes at once),
 * exactly as the queue's private map always has.
 */

/** Env var naming the hosts on the shared clock: `off` (default) | `all` | `host,host,...`. */
export const HOST_CLOCK_ENV = 'SCRAPE_HOST_CLOCK';

/** Host key: trimmed, lowercased, trailing root dots and a leading `www.` stripped. */
export function normalizeClockHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** Which hosts are on the shared clock, from `SCRAPE_HOST_CLOCK`'s raw value. */
export function parseHostClockScope(raw: string | undefined): (host: string) => boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'all') return () => true;
  if (value === '' || value === 'off') return () => false;
  const hosts = new Set(
    value
      .split(',')
      .map(normalizeClockHost)
      .filter(host => host !== ''),
  );
  return host => hosts.has(normalizeClockHost(host));
}

/** Resolves a host to its store's floor (ms), or undefined for a host no store declares. */
export type HostFloorSource = (host: string) => number | undefined;

interface Booking {
  at: number;
  floorMs: number;
}

export class HostClock {
  private readonly bookings = new Map<string, Booking>();
  private floorSource: HostFloorSource | null = null;

  /**
   * @param inScope  which hosts this clock covers (see {@link parseHostClockScope}).
   * @param rawScope the scope as configured, for {@link describe} only.
   */
  constructor(
    private readonly inScopeFn: (host: string) => boolean,
    private readonly rawScope: string = 'off',
  ) {}

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

  /** The earliest time a booking with this floor may take, given the host's latest booking. */
  private earliest(key: string, floorMs: number): number {
    const last = this.bookings.get(key);
    return last === undefined ? -Infinity : last.at + Math.max(last.floorMs, floorMs);
  }

  /**
   * Non-blocking: book `now` and return 0 when the floor has passed since the host's latest booking,
   * otherwise return the ms still to wait and book nothing.
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

  /** One boot log line: what the clock covers and, per listed host, the floor its images get. */
  describe(): string {
    const scope = this.rawScope.trim();
    const value = scope.toLowerCase();
    const hosts = value
      .split(',')
      .map(normalizeClockHost)
      .filter(host => host !== '');
    if (hosts.length === 0 || value === 'off') {
      return `[HOST-CLOCK] ${HOST_CLOCK_ENV} off: every host keeps its own lane pacing`;
    }
    const head = `[HOST-CLOCK] ${HOST_CLOCK_ENV}=${scope}: one clock per host for queue dispatch and main-host images`;
    if (value === 'all') return head;
    const floors = hosts.map(host => {
      const floor = this.floorFor(host);
      return floor === undefined ? `${host} no store floor (queue only)` : `${host} floor ${floor} ms`;
    });
    return `${head}; ${floors.join(', ')}`;
  }
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
