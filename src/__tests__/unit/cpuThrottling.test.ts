import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCpuThrottling } from '../../services/cpuThrottling';

/**
 * Whether the KERNEL is holding this process off the CPU.
 *
 * The sink's own event-loop lag says "this process was slow"; it cannot say why, and a
 * long synchronous parse looks exactly like a CPU quota. cgroup v2 keeps the direct
 * answer in `cpu.stat` — a counter, not a sample, so there is no percentile to hide
 * behind. Read beside `eventLoopLagMax` it separates "we are doing too much work" from
 * "we are not being given the CPU to do it".
 */
describe('readCpuThrottling — cgroup v2 cpu.stat', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cpustat-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = (body: string): string => {
    const p = join(dir, 'cpu.stat');
    writeFileSync(p, body);
    return p;
  };

  it('reads the throttling counters a limited cgroup publishes', () => {
    const view = readCpuThrottling(
      at('usage_usec 12345\nuser_usec 10000\nsystem_usec 2345\nnr_periods 8102\nnr_throttled 941\nthrottled_usec 20719353\n'),
    );
    expect(view).toMatchObject({
      available: true,
      nrPeriods: 8102,
      nrThrottled: 941,
      throttledUsec: 20719353,
    });
    // Cumulative counters are only readable against a clock: an operator diffs two polls.
    expect(typeof view.readAt).toBe('string');
  });

  it('reports available WITHOUT the throttle counters when no CPU limit is set', () => {
    // An unlimited cgroup publishes usage but no nr_periods — that is "no quota", which
    // must not read as "zero throttling measured".
    const view = readCpuThrottling(at('usage_usec 12345\nuser_usec 10000\nsystem_usec 2345\n'));
    expect(view.available).toBe(true);
    expect(view.nrPeriods).toBeUndefined();
    expect(view.nrThrottled).toBeUndefined();
  });

  it('says so, rather than throwing, where there is no cgroup at all', () => {
    expect(readCpuThrottling(join(dir, 'absent'))).toEqual({ available: false });
  });

  it('never throws on a malformed or unreadable file — health must not 500 on it', () => {
    expect(readCpuThrottling(at('this is not\ncpu.stat at all\n'))).toMatchObject({ available: true });
    expect(readCpuThrottling(dir)).toEqual({ available: false }); // a directory, not a file
  });

  it('ignores a value that is not a number rather than reporting NaN', () => {
    const view = readCpuThrottling(at('nr_periods 10\nnr_throttled lots\nthrottled_usec 5\n'));
    expect(view.nrPeriods).toBe(10);
    expect(view.nrThrottled).toBeUndefined();
    expect(view.throttledUsec).toBe(5);
  });
});
