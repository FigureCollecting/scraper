/**
 * requestGate — the GLOBAL egress ceiling for one initiator pass.
 *
 * The scrape queue paces per HOST, but has NO cap across the single OVH egress
 * IP: many hosts dispatched at once still leave from one address, which is what
 * degrades that address's reputation (the anitoys IP-reputation failure). This
 * gate is the interim GLOBAL cap that every outbound request passes through:
 *
 *   (a) CONCURRENCY  — at most `maxConcurrency` fns run at once, across ALL stores.
 *   (b) BUDGET       — at most `maxRequests` fns are ever dispatched in the run.
 *                      The budget slot is reserved SYNCHRONOUSLY at run() entry
 *                      (before any await), so a burst submitted via Promise.all
 *                      can never overshoot even before the first fn resolves.
 *   (c) SPACING      — consecutive dispatches start at least `spacingMs` apart.
 *
 * `now`/`sleep` are injectable so spacing is deterministically testable.
 */

export type GateResult<T> = { status: 'ok'; value: T } | { status: 'budget-exhausted' };

export interface RequestGate {
  /**
   * Run `fn` under the global caps. Returns `{status:'ok', value}` when the
   * request was dispatched, or `{status:'budget-exhausted'}` when the run's
   * total-request budget is spent — in which case `fn` is NEVER called.
   */
  run<T>(fn: () => Promise<T>): Promise<GateResult<T>>;
  /** Total requests actually dispatched so far. */
  issued(): number;
  /** Budget remaining (maxRequests − issued). */
  remaining(): number;
  /** Observed peak concurrent in-flight fns (observability). */
  peakInFlight(): number;
}

export interface RequestGateOptions {
  maxConcurrency: number;
  maxRequests: number;
  spacingMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRequestGate(opts: RequestGateOptions): RequestGate {
  const maxConcurrency = Math.max(1, Math.floor(opts.maxConcurrency));
  const maxRequests = Math.max(0, Math.floor(opts.maxRequests));
  const spacingMs = Math.max(0, opts.spacingMs);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  let issuedCount = 0;
  let inFlight = 0;
  let peak = 0;
  let nextEarliestDispatch = 0;
  const waiters: Array<() => void> = [];

  const acquireSlot = async (): Promise<void> => {
    if (inFlight < maxConcurrency) {
      inFlight++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight++;
  };

  const releaseSlot = (): void => {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  };

  const applySpacing = async (): Promise<void> => {
    if (spacingMs <= 0) return;
    const wait = Math.max(0, nextEarliestDispatch - now());
    if (wait > 0) await sleep(wait);
    nextEarliestDispatch = now() + spacingMs;
  };

  const run = async <T>(fn: () => Promise<T>): Promise<GateResult<T>> => {
    // Reserve the budget slot SYNCHRONOUSLY — no await before this decision, so
    // concurrent submitters can never collectively overshoot maxRequests.
    if (issuedCount >= maxRequests) return { status: 'budget-exhausted' };
    issuedCount++;

    await acquireSlot();
    try {
      await applySpacing();
      peak = Math.max(peak, inFlight);
      const value = await fn();
      return { status: 'ok', value };
    } finally {
      releaseSlot();
    }
  };

  return {
    run,
    issued: () => issuedCount,
    remaining: () => Math.max(0, maxRequests - issuedCount),
    peakInFlight: () => peak,
  };
}
