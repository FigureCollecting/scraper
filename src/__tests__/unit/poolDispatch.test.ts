/**
 * QB-U19: PoolDispatch, the per-process state queue dispatch keeps around the pure POOL-SELECT module:
 * the SCRAPE_POOL_SELECT scope (per-host mode pool | fifo-excluded | fifo-off, membership per call), the
 * per-host age and hard caps, one logged 32-bit seed with a derived stream per (host, 'pick'), the
 * per-class history and R1 skip marks, and the trailing-hour pick statistics behind the /health/detailed
 * pool block.
 */
import { DEFAULT_ID_PARAMS, deriveStream, select, type Candidate, type Rng } from '../../services/poolSelect';
import {
  DEFAULT_POOL_AGE_CAP_H,
  POOL_AGE_CAP_ENV,
  POOL_HARD_CAP_ENV,
  POOL_SELECT_ENV,
  POOL_WINDOW_MS,
  PoolDispatch,
  announcePoolDispatch,
  getPoolDispatch,
  setPoolDispatch,
  type PoolCandidate,
  type PoolPickEvent,
} from '../../services/poolDispatch';

const H = 3_600_000;
const NOW = 1_800_000_000_000;

afterEach(() => {
  delete process.env[POOL_SELECT_ENV];
  delete process.env[POOL_AGE_CAP_ENV];
  delete process.env[POOL_HARD_CAP_ENV];
  setPoolDispatch(null);
});

const fresh = (n: number, start = 1000, nowMs = NOW, prefix = 'k'): PoolCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${String(i).padStart(4, '0')}`, recencyMs: nowMs - i * 1000, classEnteredAtMs: nowMs - i * 1000, numId: start + i * 10, retry: false }));

describe('PoolDispatch: per-host mode from SCRAPE_POOL_SELECT', () => {
  it('off by default (env unset): every host fifo-off', () => {
    const pd = new PoolDispatch();
    expect(pd.modeFor('myfigurecollection.net')).toBe('fifo-off');
    expect(pd.scopeView()).toEqual({ scope: 'off', malformed: false, hosts: [] });
  });

  it("reads the env when no value is passed: 'all,-host' -> excluded host fifo-excluded, every other host (seen or not) pool", () => {
    process.env[POOL_SELECT_ENV] = 'all,-myfigurecollection.net';
    const pd = new PoolDispatch({ seed: 1 });
    expect(pd.modeFor('www.MyFigureCollection.net.')).toBe('fifo-excluded');
    expect(pd.modeFor('hpoi.net')).toBe('pool');
    expect(pd.modeFor(`brand-new-${Math.random()}.test`)).toBe('pool');
    expect(pd.scopeView()).toEqual({ scope: 'all-except', malformed: false, hosts: ['myfigurecollection.net'] });
  });

  it('a host list pools only those hosts; the rest are fifo-off', () => {
    const pd = new PoolDispatch({ select: 'hpoi.net', seed: 1 });
    expect(pd.modeFor('hpoi.net')).toBe('pool');
    expect(pd.modeFor('fast.test')).toBe('fifo-off');
  });

  it('a malformed value is off, with exactly one warning naming it', () => {
    const pd = new PoolDispatch({ select: 'all,myfigurecollection.net', seed: 1 });
    expect(pd.modeFor('myfigurecollection.net')).toBe('fifo-off');
    expect(pd.modeFor('hpoi.net')).toBe('fifo-off');
    expect(pd.scopeView()).toEqual({ scope: 'off', malformed: true, hosts: [] });
    const warnings = pd.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"all,myfigurecollection.net"');
    expect(warnings[0]).toContain(POOL_SELECT_ENV);
  });
});

describe('PoolDispatch: age and hard caps', () => {
  it(`defaults: age cap ${DEFAULT_POOL_AGE_CAP_H} h, hard cap 2 x age cap`, () => {
    const pd = new PoolDispatch({ select: 'all', seed: 1 });
    expect(pd.capsFor('hpoi.net')).toEqual({ ageCapMs: 12 * H, hardCapMs: 24 * H });
    expect(pd.warnings()).toEqual([]);
  });

  it('per-host overrides (host normalised, decimals allowed); the hard cap defaults to 2 x that host\'s age cap', () => {
    const pd = new PoolDispatch({ select: 'all', ageCaps: 'WWW.HPOI.net=6, fast.test=0.5', hardCaps: 'fast.test=3', seed: 1 });
    expect(pd.capsFor('hpoi.net')).toEqual({ ageCapMs: 6 * H, hardCapMs: 12 * H });
    expect(pd.capsFor('fast.test')).toEqual({ ageCapMs: 0.5 * H, hardCapMs: 3 * H });
    expect(pd.capsFor('other.test')).toEqual({ ageCapMs: 12 * H, hardCapMs: 24 * H });
    expect(pd.warnings()).toEqual([]);
  });

  it('reads both cap knobs from the env', () => {
    process.env[POOL_AGE_CAP_ENV] = 'hpoi.net=2';
    process.env[POOL_HARD_CAP_ENV] = 'hpoi.net=5';
    expect(new PoolDispatch({ select: 'all', seed: 1 }).capsFor('hpoi.net')).toEqual({ ageCapMs: 2 * H, hardCapMs: 5 * H });
  });

  it.each(['hpoi.net', 'hpoi.net=', '=4', 'hpoi.net=0', 'hpoi.net=-1', 'hpoi.net=abc', 'hpoi.net=Infinity', 'http://hpoi.net=4'])(
    'a bad age-cap entry %p is ignored with a warning',
    (entry) => {
      const pd = new PoolDispatch({ select: 'all', ageCaps: entry, seed: 1 });
      expect(pd.capsFor('hpoi.net')).toEqual({ ageCapMs: 12 * H, hardCapMs: 24 * H });
      expect(pd.warnings()).toHaveLength(1);
      expect(pd.warnings()[0]).toContain(POOL_AGE_CAP_ENV);
    },
  );

  it('a hard cap below the age cap is refused with a warning (the default 2 x age cap applies)', () => {
    const pd = new PoolDispatch({ select: 'all', ageCaps: 'hpoi.net=6', hardCaps: 'hpoi.net=5', seed: 1 });
    expect(pd.capsFor('hpoi.net')).toEqual({ ageCapMs: 6 * H, hardCapMs: 12 * H });
    expect(pd.warnings()).toHaveLength(1);
    expect(pd.warnings()[0]).toContain(POOL_HARD_CAP_ENV);
  });

  it('empty entries between commas are skipped; a hard cap for a host with no age override is checked against 12 h', () => {
    const ok = new PoolDispatch({ select: 'all', ageCaps: 'hpoi.net=2,, fast.test=3,', hardCaps: 'other.test=30', seed: 1 });
    expect(ok.capsFor('hpoi.net').ageCapMs).toBe(2 * H);
    expect(ok.capsFor('fast.test').ageCapMs).toBe(3 * H);
    expect(ok.capsFor('other.test')).toEqual({ ageCapMs: 12 * H, hardCapMs: 30 * H });
    expect(ok.warnings()).toEqual([]);
    const low = new PoolDispatch({ select: 'all', hardCaps: 'other.test=5', seed: 1 });
    expect(low.capsFor('other.test')).toEqual({ ageCapMs: 12 * H, hardCapMs: 24 * H });
    expect(low.warnings()).toHaveLength(1);
  });

  it('a hard cap equal to the age cap is accepted', () => {
    const pd = new PoolDispatch({ select: 'all', ageCaps: 'hpoi.net=6', hardCaps: 'hpoi.net=6', seed: 1 });
    expect(pd.capsFor('hpoi.net')).toEqual({ ageCapMs: 6 * H, hardCapMs: 6 * H });
    expect(pd.warnings()).toEqual([]);
  });
});

describe('PoolDispatch: seed and streams', () => {
  it('without a seed it draws one 32-bit seed per instance', () => {
    const seeds = new Set(Array.from({ length: 8 }, () => new PoolDispatch().seed));
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(2 ** 32);
    }
    expect(seeds.size).toBeGreaterThan(1);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('refuses the seed %p', (seed) => {
    expect(() => new PoolDispatch({ seed })).toThrow(RangeError);
  });

  it('accepts the seeds 0 and 2^32 - 1', () => {
    expect(new PoolDispatch({ seed: 0 }).seed).toBe(0);
    expect(new PoolDispatch({ seed: 2 ** 32 - 1 }).seed).toBe(2 ** 32 - 1);
  });

  it('picks replay from the logged seed: the stream is deriveStream(seed, host, "pick") into select()', () => {
    const seed = 0xdecafbad;
    const pd = new PoolDispatch({ select: 'all', seed });
    const ref = deriveStream(seed, 'hpoi.net', 'pick');
    const cands = fresh(60);
    let prev: number | undefined;
    let prev2: number | undefined;
    for (let i = 0; i < 40; i++) {
      const got = pd.pick('hpoi.net', 'hpoi.net|WARM', cands, NOW);
      const pool: Candidate[] = cands.map((c) => ({ key: c.key, tier: 0, recency: c.recencyMs, numId: c.numId, classEnteredAtMs: c.classEnteredAtMs, skipped: false }));
      const want = select({ kind: 'explicit', candidates: pool }, { ...DEFAULT_ID_PARAMS, ageCapMs: 12 * H, hardCapMs: 24 * H }, { rng: ref, nowMs: NOW, history: { prev, prev2 } });
      expect(cands[got].key).toBe(want?.candidate.key);
      prev2 = prev;
      prev = cands[got].numId;
    }
  });

  it('the same seed gives the same picks; another seed does not', () => {
    const run = (seed: number) => {
      const pd = new PoolDispatch({ select: 'all', seed });
      const cands = fresh(80);
      return Array.from({ length: 50 }, () => cands[pd.pick('hpoi.net', 'hpoi.net|WARM', cands, NOW)].key);
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('each host has its own stream: picks on one host do not move another host\'s sequence', () => {
    const a = new PoolDispatch({ select: 'all', seed: 9 });
    const b = new PoolDispatch({ select: 'all', seed: 9 });
    const cands = fresh(80);
    for (let i = 0; i < 25; i++) a.pick('other.test', 'other.test|WARM', cands, NOW);
    const seqA = Array.from({ length: 20 }, () => cands[a.pick('hpoi.net', 'hpoi.net|WARM', cands, NOW)].key);
    const seqB = Array.from({ length: 20 }, () => cands[b.pick('hpoi.net', 'hpoi.net|WARM', cands, NOW)].key);
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBeGreaterThan(5);
  });

  it('an injected rng (tests) replaces the derived stream', () => {
    const calls: string[] = [];
    const pd = new PoolDispatch({ select: 'all', seed: 1, rngFor: (host) => { calls.push(host); return () => 0; } });
    const cands = fresh(40);
    expect(cands[pd.pick('hpoi.net', 'hpoi.net|WARM', cands, NOW)].key).toBe('k0000');
    pd.pick('hpoi.net', 'hpoi.net|COLD', cands, NOW);
    expect(calls).toEqual(['hpoi.net']);
  });

  it('an empty pool picks nothing (-1)', () => {
    const pd = new PoolDispatch({ select: 'all', seed: 1 });
    expect(pd.pick('hpoi.net', 'hpoi.net|WARM', [], NOW)).toBe(-1);
    expect(pd.hostStats('hpoi.net', NOW).picks60m).toBe(0);
  });
});

describe('PoolDispatch: per-class history and R1 skip marks', () => {
  const HARD = 'hpoi.net=0.001'; // age cap 3.6 s, hard cap 7.2 s
  const at = (key: string, numId: number, enteredAt: number): PoolCandidate => ({ key, recencyMs: enteredAt, classEnteredAtMs: enteredAt, numId, retry: false });

  it('marks the oldest hard-aged item it skips, forces it next time, and forget() clears the mark', () => {
    const events: PoolPickEvent[] = [];
    const pd = new PoolDispatch({ select: 'all', ageCaps: HARD, seed: 3, onPick: (e) => events.push(e) });
    const K = 'hpoi.net|WARM';
    const old = NOW - 60_000;
    // prev = 11: the oldest hard-aged item (id 10) fails anti-sequence -> marked, the next oldest goes.
    pd.pick('hpoi.net', K, [at('p', 11, NOW)], NOW);
    pd.pick('hpoi.net', K, [at('a', 10, old), at('b', 500, old + 1)], NOW);
    expect(events[1]).toMatchObject({ key: 'b', rule: 'R1', stage: 'R1', markSkip: 'a' });
    // prev = 12 again: 'a' still fails anti-sequence, and it is marked -> forced.
    pd.pick('hpoi.net', K, [at('q', 12, NOW)], NOW);
    pd.pick('hpoi.net', K, [at('a', 10, old), at('c', 600, old + 2)], NOW);
    expect(events[3]).toMatchObject({ key: 'a', rule: 'R1-forced' });
    expect(events[3].markSkip).toBeUndefined();
    // Completed (or given up): the mark goes, so a re-queued 'a' is skipped once more, not forced.
    pd.forget('a');
    pd.pick('hpoi.net', K, [at('r', 13, NOW)], NOW);
    pd.pick('hpoi.net', K, [at('a', 10, old), at('d', 700, old + 3)], NOW);
    expect(events[5]).toMatchObject({ key: 'd', rule: 'R1', markSkip: 'a' });
  });

  it('history is per class: a pick in another class of the host does not move this class\'s anti-sequence', () => {
    const events: PoolPickEvent[] = [];
    const pd = new PoolDispatch({ select: 'all', ageCaps: HARD, seed: 3, onPick: (e) => events.push(e) });
    const old = NOW - 60_000;
    pd.pick('hpoi.net', 'hpoi.net|COLD', [at('x', 11, NOW)], NOW);
    pd.pick('hpoi.net', 'hpoi.net|WARM', [at('a', 10, old), at('b', 500, old + 1)], NOW);
    expect(events[1]).toMatchObject({ key: 'a', rule: 'R1' });
    expect(events[1].markSkip).toBeUndefined();
  });

  it('marks live per class: a mark in one class does not force the same key in another', () => {
    const events: PoolPickEvent[] = [];
    const pd = new PoolDispatch({ select: 'all', ageCaps: HARD, seed: 3, onPick: (e) => events.push(e) });
    const old = NOW - 60_000;
    pd.pick('hpoi.net', 'hpoi.net|WARM', [at('p', 11, NOW)], NOW);
    pd.pick('hpoi.net', 'hpoi.net|WARM', [at('a', 10, old), at('b', 500, old + 1)], NOW);
    pd.pick('hpoi.net', 'hpoi.net|COLD', [at('q', 12, NOW)], NOW);
    pd.pick('hpoi.net', 'hpoi.net|COLD', [at('a', 10, old), at('c', 600, old + 2)], NOW);
    expect(events[3]).toMatchObject({ key: 'c', rule: 'R1', markSkip: 'a' });
  });

  it('ties at the same class entry are broken by the key, numeric keys in numeric order (zero-padded)', () => {
    const events: PoolPickEvent[] = [];
    const pd = new PoolDispatch({ select: 'all', ageCaps: HARD, seed: 3, onPick: (e) => events.push(e) });
    const old = NOW - 60_000;
    pd.pick('hpoi.net', 'hpoi.net|WARM', [at('10', 900, old), at('9', 100, old)], NOW);
    expect(events[0]).toMatchObject({ key: '9', rule: 'R1' });
  });
});

describe('PoolDispatch: the trailing-hour statistics behind the pool block', () => {
  /** Scripted rng: returns the queued values in order, then 0.5. */
  const script = (values: number[]): Rng => () => (values.length > 0 ? (values.shift() as number) : 0.5);

  it('counts each rule, wait and retry over the trailing hour, and forgets older picks', () => {
    const queue: number[] = [];
    const events: PoolPickEvent[] = [];
    const pd = new PoolDispatch({ select: 'all', ageCaps: 'hpoi.net=1', seed: 1, rngFor: () => script(queue), onPick: (e) => events.push(e) });
    const K = 'hpoi.net|WARM';
    const freshPool = fresh(30, 1000);
    // 1: uniform (coin 0.05 < floor 0.10), rank floor(0.4 * 30) = 12 -> bucket 0.
    queue.push(0.05, 0.4);
    pd.pick('hpoi.net', K, freshPool, NOW);
    // 2: R3 bucket draw (coin 0.5, bucket x 0.9 * 1.5 = 1.35 -> bucket 1 = ranks 25..29), rank 25 + floor(0.2 * 5) = 26.
    queue.push(0.5, 0.9, 0.2);
    pd.pick('hpoi.net', K, freshPool, NOW + 1000);
    // 3: aged (1.5 h old, age cap 1 h, hard cap 2 h): R2 coin 0.05 < 0.9, then the draw.
    queue.push(0.05, 0.0);
    const aged = fresh(5, 5000, NOW - 1.5 * H, 'a');
    pd.pick('hpoi.net', K, [...aged, ...fresh(3, 9000, NOW, 'f')], NOW + 2000);
    // 4: hard-aged (3 h): R1, no draws; a retry.
    pd.pick('hpoi.net', K, [{ key: 'old', recencyMs: NOW - 3 * H, classEnteredAtMs: NOW - 3 * H, numId: 77_000, retry: true }, ...fresh(3, 9000, NOW, 'g')], NOW + 3000);
    // 5: a single candidate that fails anti-sequence (prev 77000): a fallback in a pool of one (not an anomaly).
    pd.pick('hpoi.net', K, [{ key: 'solo', recencyMs: NOW, classEnteredAtMs: NOW, numId: 77_001, retry: false }], NOW + 4000);
    // 6: two candidates, both failing anti-sequence (prev 77001, prev2 77000): redraws, then a fallback that counts.
    pd.pick('hpoi.net', K, [
      { key: 'n1', recencyMs: NOW, classEnteredAtMs: NOW, numId: 77_002, retry: false },
      { key: 'n2', recencyMs: NOW - 1, classEnteredAtMs: NOW - 1, numId: 77_003, retry: false },
    ], NOW + 5000);

    expect(events.map((e) => e.rule)).toEqual(['uniform', 'R3', 'R2', 'R1', 'fallback', 'fallback']);
    const s = pd.hostStats('hpoi.net', NOW + 5000);
    expect(s.picks60m).toBe(6);
    expect(s.uniformPicks60m).toBe(1);
    expect(s.agedPicks60m).toBe(1);
    expect(s.agedShare60m).toBeCloseTo(1 / 6, 3);
    expect(s.forcedPicks60m).toBe(0);
    expect(s.retryPicks60m).toBe(1);
    expect(s.scanFallbacks60m).toBe(1);
    // R3-stage picks: uniform rank 12 (top bucket), R3 rank 26, the two fallbacks (ranks 0 and 1).
    expect(s.topBucketShare60m).toBeCloseTo(3 / 4, 3);
    expect(s.redraws60m).toBe(events.reduce((a, e) => a + e.redraws, 0));
    expect(s.redraws60m).toBeGreaterThanOrEqual(2 * DEFAULT_ID_PARAMS.maxRedraws);
    expect(s.maxWaitH60m).toBeCloseTo((3 * H + 3000) / H, 3);
    expect(s.p99WaitH60m).toBeCloseTo((3 * H + 3000) / H, 3);
    expect(events[3]).toMatchObject({ key: 'old', retry: true, waitMs: 3 * H + 3000, poolSize: 4 });

    // An hour after the last pick nothing is left in the window; the host is no longer listed as seen.
    expect(pd.hostsSeen(NOW + 5000)).toEqual(['hpoi.net']);
    const later = NOW + 5000 + POOL_WINDOW_MS;
    expect(pd.hostStats('hpoi.net', later)).toEqual({
      picks60m: 0, topBucketShare60m: 0, uniformPicks60m: 0, agedPicks60m: 0, agedShare60m: 0, forcedPicks60m: 0,
      p99WaitH60m: 0, maxWaitH60m: 0, redraws60m: 0, scanFallbacks60m: 0, retryPicks60m: 0,
    });
    expect(pd.hostsSeen(later)).toEqual([]);
  });

  it('p99 is the sorted wait at floor(0.99 n), as the simulations take it', () => {
    const pd = new PoolDispatch({ select: 'all', seed: 5 });
    const K = 'hpoi.net|WARM';
    for (let i = 0; i < 200; i++) {
      // One candidate, entered i minutes ago (all younger than the 12 h age cap): its wait is i minutes.
      pd.pick('hpoi.net', K, [{ key: `w${i}`, recencyMs: NOW - i * 60_000, classEnteredAtMs: NOW - i * 60_000, retry: false }], NOW);
    }
    const s = pd.hostStats('hpoi.net', NOW);
    expect(s.maxWaitH60m).toBeCloseTo(199 / 60, 3);
    expect(s.p99WaitH60m).toBeCloseTo(198 / 60, 3);
  });

  it('topBucketShare60m is 0 when the hour holds no recency (R3) pick', () => {
    const pd = new PoolDispatch({ select: 'all', ageCaps: 'hpoi.net=0.001', seed: 3 });
    pd.pick('hpoi.net', 'hpoi.net|WARM', [{ key: 'a', recencyMs: NOW - 60_000, classEnteredAtMs: NOW - 60_000, numId: 10, retry: false }], NOW);
    expect(pd.hostStats('hpoi.net', NOW)).toMatchObject({ picks60m: 1, topBucketShare60m: 0 });
  });

  it('counts forced picks', () => {
    const events: PoolPickEvent[] = [];
    const pd = new PoolDispatch({ select: 'all', ageCaps: 'hpoi.net=0.001', seed: 3, onPick: (e) => events.push(e) });
    const K = 'hpoi.net|WARM';
    pd.pick('hpoi.net', K, [{ key: 'p', recencyMs: NOW, classEnteredAtMs: NOW, numId: 11, retry: false }], NOW);
    // The only hard-aged item fails anti-sequence and no other passes: forced, and marked.
    pd.pick('hpoi.net', K, [{ key: 'a', recencyMs: NOW - 60_000, classEnteredAtMs: NOW - 60_000, numId: 10, retry: false }], NOW);
    expect(events[1]).toMatchObject({ rule: 'R1-forced', markSkip: 'a' });
    expect(pd.hostStats('hpoi.net', NOW).forcedPicks60m).toBe(1);
  });
});

describe('getPoolDispatch / setPoolDispatch / announcePoolDispatch', () => {
  it('the process instance is built from the env on first use and replaced by setPoolDispatch', () => {
    process.env[POOL_SELECT_ENV] = 'all';
    const first = getPoolDispatch();
    expect(getPoolDispatch()).toBe(first);
    expect(first.modeFor('hpoi.net')).toBe('pool');
    const custom = new PoolDispatch({ select: 'off', seed: 1 });
    setPoolDispatch(custom);
    expect(getPoolDispatch()).toBe(custom);
    setPoolDispatch(null);
    process.env[POOL_SELECT_ENV] = 'off';
    expect(getPoolDispatch().modeFor('hpoi.net')).toBe('fifo-off');
  });

  it('boot: one warning per refused value, then one line naming the knob, scope, caps and the seed', () => {
    const log = { log: jest.fn(), warn: jest.fn() };
    const pd = new PoolDispatch({ select: '+hpoi.net', ageCaps: 'hpoi.net=x', seed: 123456789 });
    announcePoolDispatch(pd, log);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('"+hpoi.net"');
    expect(log.log).toHaveBeenCalledTimes(1);
    const line = String(log.log.mock.calls[0]?.[0]);
    expect(line).toMatch(/^\[POOL\] /);
    expect(line).toContain('seed=123456789');
    expect(line).toContain('scope=off');
    expect(line).toContain('malformed');
  });

  it("boot line for a host list names the hosts; for 'all' it names no host", () => {
    expect(new PoolDispatch({ select: 'hpoi.net,fast.test', seed: 2 }).describe()).toContain('scope=hosts hosts=hpoi.net,fast.test ');
    const all = new PoolDispatch({ select: 'all', seed: 2 }).describe();
    expect(all).toContain('scope=all ageCapH=12 hardCapH=24 seed=2');
  });

  it('logs to the console by default', () => {
    const log = console.log as unknown as jest.Mock;
    log.mockClear();
    announcePoolDispatch(new PoolDispatch({ select: 'off', seed: 4 }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('seed=4'));
  });

  it("boot line for 'all,-host' names the excluded hosts and the cap overrides", () => {
    const log = { log: jest.fn(), warn: jest.fn() };
    announcePoolDispatch(new PoolDispatch({ select: 'all,-myfigurecollection.net', ageCaps: 'hpoi.net=6', seed: 7 }), log);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
    const line = String(log.log.mock.calls[0]?.[0]);
    expect(line).toContain('scope=all-except');
    expect(line).toContain('myfigurecollection.net');
    expect(line).toContain('hpoi.net=6/12');
    expect(line).toContain('seed=7');
  });
});
