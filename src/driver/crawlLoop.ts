/**
 * CrawlLoop — the crawl driver's async runtime. Turns a DispatchScheduler into a running
 * crawler: greedily dispatch every task runnable at the current instant (launching a worker
 * per dispatch, concurrently up to each pool's capacity), then block until either an in-flight
 * worker finishes (freeing a pool slot) or the next throttled host becomes ready
 * (`msUntilNext`) — whichever comes first. Each worker's result is settled back onto the
 * scheduler (success → recover the host delay, rate-limited/thrown → back off).
 *
 * All effects are injected — `now()`, `sleep(ms)`, and the `worker` — so the loop is
 * deterministic and testable with a virtual clock (no real timers). The worker is where I2
 * plugs in: fetch → catch-gated extract → SpineIngest emit.
 */
import type { CrawlTask, DispatchScheduler, Outcome } from './dispatchScheduler.js';
import type { PoolKind } from './poolRouter.js';

export interface CrawlLoopDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Process one dispatched task. A thrown error is treated as a rate-limit (backs the host off). */
  worker: (task: CrawlTask) => Promise<Outcome>;
}

export interface CrawlLoopStats {
  dispatched: number;
  completed: number;
  failed: number;
}

export class CrawlLoop {
  constructor(
    private readonly scheduler: DispatchScheduler,
    private readonly deps: CrawlLoopDeps,
    /** Cap a single sleep so a very long throttle still wakes to re-check periodically. */
    private readonly maxTickMs = 60_000,
  ) {}

  async run(): Promise<CrawlLoopStats> {
    const inFlight = new Set<Promise<void>>();
    const stats: CrawlLoopStats = { dispatched: 0, completed: 0, failed: 0 };

    const launch = (task: CrawlTask, pool: PoolKind): void => {
      stats.dispatched += 1;
      let tracked: Promise<void>;
      const work = (async () => {
        let outcome: Outcome;
        try {
          outcome = await this.deps.worker(task);
        } catch {
          outcome = 'rate-limited';
          stats.failed += 1;
        }
        this.scheduler.settle(task, pool, outcome);
        stats.completed += 1;
      })();
      tracked = work.finally(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
    };

    while (true) {
      // Dispatch everything runnable right now.
      let d = this.scheduler.dispatch(this.deps.now());
      while (d !== null) {
        launch(d.task, d.pool);
        d = this.scheduler.dispatch(this.deps.now());
      }

      if (this.scheduler.pending() === 0 && inFlight.size === 0) break; // drained

      const wait = this.scheduler.msUntilNext(this.deps.now());
      if (inFlight.size > 0) {
        // Wake on the earlier of: a worker completing (frees a pool slot), or a host readying.
        const racers: Array<Promise<unknown>> = [...inFlight];
        if (wait !== Infinity) racers.push(this.deps.sleep(Math.min(wait, this.maxTickMs)));
        await Promise.race(racers);
      } else {
        // Nothing in flight: the only blocker is host throttle. Infinity here means no pool can
        // ever admit the pending work (misconfigured zero capacity) — stop rather than spin.
        if (wait === Infinity) break;
        await this.deps.sleep(Math.min(wait, this.maxTickMs));
      }
    }

    return stats;
  }
}
