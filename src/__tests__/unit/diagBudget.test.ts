/**
 * TDD (red first) — src/diag/budget.ts, the request budget behind every diagnostic probe
 * (hands-off plan unit S1).
 *
 * WHY: a diag probe is the ONLY way the engine contacts a hands-off host on demand, so the number of
 * requests it may send is the safety property. Two caps apply to every call:
 *   - per call: min(requested, the probe's hard maximum) — robots-snapshot 1, item-status 2;
 *   - per host: DIAG_HOST_DAILY_CAP requests in any rolling 24 h, persisted in the diag_budget
 *     table of the queue sqlite so a restart does not reset it.
 * A request is charged BEFORE it is dispatched and is never refunded, so a dispatch that fails still
 * counts. These tests pin all of that with real sqlite files under os.tmpdir() and an injected clock.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_DIAG_HOST_DAILY_CAP,
  DIAG_BUDGET_WINDOW_MS,
  DIAG_HOST_DAILY_CAP_ENV,
  openDiagBudget,
  probeMaxRequests,
  resolveHostDailyCap,
  type DiagBudget,
} from '../../diag/budget';
import { Probe } from '../../gen/fc/diag/v1/diag_pb';
import { openQueueStore, QUEUE_DB_FILE, QUEUE_DIR_ENV } from '../../services/queueStore';

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 2, 16, 0, 0);

let dirs: string[] = [];
let budgets: DiagBudget[] = [];
const savedEnv = { cap: process.env[DIAG_HOST_DAILY_CAP_ENV], dir: process.env[QUEUE_DIR_ENV] };

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-budget-test-'));
  dirs.push(d);
  return d;
}

/** A settable clock. */
function clock(start = T0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function open(dir: string, hostDailyCap: number, now: () => number = () => T0): DiagBudget {
  const b = openDiagBudget({ dir, hostDailyCap, now });
  budgets.push(b);
  return b;
}

/** Rows in diag_budget, read through an independent handle (what a restarted process would see). */
function rows(dir: string): Array<{ host: string; at: number; probe: string; run_id: string }> {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    return db.prepare('SELECT host, at, probe, run_id FROM diag_budget ORDER BY at, id').all() as unknown as Array<{
      host: string;
      at: number;
      probe: string;
      run_id: string;
    }>;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const b of budgets) {
    try {
      b.close();
    } catch {
      /* already closed by the test */
    }
  }
  budgets = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  for (const [key, value] of [
    [DIAG_HOST_DAILY_CAP_ENV, savedEnv.cap],
    [QUEUE_DIR_ENV, savedEnv.dir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('probeMaxRequests — the per-probe hard maximum', () => {
  it('robots-snapshot may send 1 request, item-status 2', () => {
    expect(probeMaxRequests(Probe.ROBOTS_SNAPSHOT)).toBe(1);
    expect(probeMaxRequests(Probe.ITEM_STATUS)).toBe(2);
  });

  it('every probe the proto declares has a maximum (a new probe cannot ship without one)', () => {
    const declared = Object.values(Probe).filter((v): v is Probe => typeof v === 'number' && v !== Probe.UNSPECIFIED);
    expect(declared.length).toBeGreaterThan(0);
    for (const p of declared) expect(probeMaxRequests(p)).toBeGreaterThanOrEqual(1);
  });

  it('UNSPECIFIED and an unknown wire value have no maximum and throw', () => {
    expect(() => probeMaxRequests(Probe.UNSPECIFIED)).toThrow(/no request maximum/);
    expect(() => probeMaxRequests(99 as Probe)).toThrow(/no request maximum/);
  });
});

describe('resolveHostDailyCap — DIAG_HOST_DAILY_CAP', () => {
  it('unset means the default, 6', () => {
    expect(DEFAULT_DIAG_HOST_DAILY_CAP).toBe(6);
    expect(resolveHostDailyCap({})).toBe(6);
  });

  it('reads a well-formed non-negative integer, 0 included (refuse everything)', () => {
    expect(resolveHostDailyCap({ [DIAG_HOST_DAILY_CAP_ENV]: '0' })).toBe(0);
    expect(resolveHostDailyCap({ [DIAG_HOST_DAILY_CAP_ENV]: '1' })).toBe(1);
    expect(resolveHostDailyCap({ [DIAG_HOST_DAILY_CAP_ENV]: '12' })).toBe(12);
  });

  it.each(['', ' ', 'abc', '6.5', '-1', '+6', '1e3', '0x6', '06', ' 6', '6 ', '6\n', 'Infinity', '9007199254740993'])(
    'a malformed value %j is fatal and names the variable',
    (raw) => {
      expect(() => resolveHostDailyCap({ [DIAG_HOST_DAILY_CAP_ENV]: raw })).toThrow(DIAG_HOST_DAILY_CAP_ENV);
    }
  );

  it('the error quotes the offending value', () => {
    expect(() => resolveHostDailyCap({ [DIAG_HOST_DAILY_CAP_ENV]: 'six' })).toThrow(/'six'/);
  });

  it('defaults to process.env', () => {
    process.env[DIAG_HOST_DAILY_CAP_ENV] = '4';
    expect(resolveHostDailyCap()).toBe(4);
  });
});

describe('openDiagBudget — the diag_budget table in the queue sqlite', () => {
  it('creates diag_budget inside <dir>/scrape-queue.db', () => {
    const dir = tmpDir();
    open(dir, 6);
    const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name
      );
      expect(names).toContain('diag_budget');
    } finally {
      db.close();
    }
  });

  it('shares the file with the scrape queue without disturbing it', () => {
    const dir = tmpDir();
    const queue = openQueueStore({ dir });
    try {
      queue.put({
        id: 'q-1',
        mfcId: 'https://store.example/item/1',
        url: 'https://store.example/item/1',
        priority: 'WARM',
        attempts: 0,
        maxRetries: 3,
        enqueuedAt: 1_000,
        state: 'pending',
      });
      const budget = open(dir, 6);
      expect(budget.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'r' }).charge()).toBe(true);
      expect(queue.counts().pending).toBe(1);
    } finally {
      queue.close();
    }
    expect(rows(dir)).toHaveLength(1);
  });

  it('without hostDailyCap it reads DIAG_HOST_DAILY_CAP, and a malformed value is fatal at open', () => {
    const dir = tmpDir();
    process.env[DIAG_HOST_DAILY_CAP_ENV] = '3';
    const b = openDiagBudget({ dir });
    budgets.push(b);
    expect(b.hostDailyCap).toBe(3);
    process.env[DIAG_HOST_DAILY_CAP_ENV] = 'lots';
    expect(() => openDiagBudget({ dir })).toThrow(DIAG_HOST_DAILY_CAP_ENV);
  });

  it('without dir it opens the queue directory (SCRAPE_QUEUE_DIR)', () => {
    const dir = tmpDir();
    process.env[QUEUE_DIR_ENV] = dir;
    const b = openDiagBudget({ hostDailyCap: 6, now: () => T0 });
    budgets.push(b);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'r' }).charge();
    expect(rows(dir)).toHaveLength(1);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses hostDailyCap %p by name', (cap) => {
    expect(() => openDiagBudget({ dir: tmpDir(), hostDailyCap: cap })).toThrow(/hostDailyCap/);
  });

  it('throws when the directory does not exist (the caller treats diag as unavailable)', () => {
    expect(() => openDiagBudget({ dir: path.join(tmpDir(), 'missing'), hostDailyCap: 6 })).toThrow();
  });
});

describe('the per-call cap: min(requested, probe maximum, host remaining)', () => {
  it.each([
    [Probe.ROBOTS_SNAPSHOT, undefined, 1],
    [Probe.ROBOTS_SNAPSHOT, 5, 1],
    [Probe.ITEM_STATUS, undefined, 2],
    [Probe.ITEM_STATUS, 1, 1],
    [Probe.ITEM_STATUS, 3, 2],
  ])('probe %p requested %p is granted %p', (probe, requested, granted) => {
    const b = open(tmpDir(), 6);
    const call = b.startCall({ probe, host: 'store.example', runId: 'r', ...(requested !== undefined ? { requested } : {}) });
    expect(call.granted).toBe(granted);
    expect(call.refusal).toBeNull();
  });

  it('requested 0 grants nothing, says why, and writes no row', () => {
    const dir = tmpDir();
    const b = open(dir, 6);
    const call = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', requested: 0, runId: 'r' });
    expect(call.granted).toBe(0);
    expect(call.refusal).toBe('none-requested');
    expect(call.charge()).toBe(false);
    expect(rows(dir)).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.NaN])('requested %p is a programming error', (requested) => {
    const b = open(tmpDir(), 6);
    expect(() => b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', requested, runId: 'r' })).toThrow(RangeError);
  });

  it('an empty host is a programming error', () => {
    const b = open(tmpDir(), 6);
    expect(() => b.startCall({ probe: Probe.ITEM_STATUS, host: '  ', runId: 'r' })).toThrow(/host/);
  });

  it('a call charges at most its grant: the charge after the last one is refused and writes nothing', () => {
    const dir = tmpDir();
    const b = open(dir, 6);
    const call = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'run-7' });
    expect(call.charge()).toBe(true);
    expect(call.charge()).toBe(true);
    expect(call.charge()).toBe(false);
    expect(call.spent).toBe(2);
    expect(rows(dir)).toEqual([
      { host: 'store.example', at: T0, probe: 'ITEM_STATUS', run_id: 'run-7' },
      { host: 'store.example', at: T0, probe: 'ITEM_STATUS', run_id: 'run-7' },
    ]);
    expect(b.remaining('store.example')).toBe(4);
  });

  it('the grant is limited by what the host has left', () => {
    const b = open(tmpDir(), 3);
    const first = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'a' });
    first.charge();
    first.charge();
    const second = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'b' });
    expect(second.granted).toBe(1);
    expect(second.charge()).toBe(true);
    expect(second.charge()).toBe(false);
  });
});

describe('the per-host rolling 24 h cap', () => {
  it('refuses at the cap: once DIAG_HOST_DAILY_CAP requests are charged, a new call is granted 0', () => {
    const dir = tmpDir();
    const b = open(dir, 6);
    for (const runId of ['a', 'b', 'c']) {
      const call = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId });
      expect(call.charge()).toBe(true);
      expect(call.charge()).toBe(true);
    }
    expect(b.remaining('store.example')).toBe(0);
    const refused = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'd' });
    expect(refused.granted).toBe(0);
    expect(refused.refusal).toBe('host-cap');
    expect(refused.charge()).toBe(false);
    expect(rows(dir)).toHaveLength(6);
  });

  it('a cap of 0 refuses every call', () => {
    const b = open(tmpDir(), 0);
    const call = b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'r' });
    expect(call.refusal).toBe('host-cap');
    expect(call.charge()).toBe(false);
  });

  it('each host has its own budget', () => {
    const b = open(tmpDir(), 1);
    expect(b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'one.example', runId: 'r' }).charge()).toBe(true);
    expect(b.remaining('one.example')).toBe(0);
    expect(b.remaining('two.example')).toBe(1);
    expect(b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'two.example', runId: 'r' }).charge()).toBe(true);
  });

  it('hosts are normalised: case and a leading www. share one budget', () => {
    const dir = tmpDir();
    const b = open(dir, 2);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'WWW.Store.Example', runId: 'r' }).charge();
    expect(b.remaining('store.example')).toBe(1);
    expect(rows(dir)[0].host).toBe('store.example');
  });

  it('counts a failed dispatch: the charge lands on disk before the dispatch and is never refunded', async () => {
    const dir = tmpDir();
    const b = open(dir, 6);
    const call = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'r' });
    let seenDuringDispatch = -1;
    const dispatch = async (): Promise<void> => {
      seenDuringDispatch = rows(dir).length;
      throw new Error('ECONNRESET');
    };
    if (call.charge()) await dispatch().catch(() => undefined);
    expect(seenDuringDispatch).toBe(1);
    expect(b.remaining('store.example')).toBe(5);
    b.close();
    expect(open(dir, 6).remaining('store.example')).toBe(5);
  });

  it('survives re-opening the sqlite file (a restart does not reset it)', () => {
    const dir = tmpDir();
    const first = open(dir, 6);
    const call = first.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'r' });
    call.charge();
    call.charge();
    first.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'r2' }).charge();
    first.close();
    const reopened = open(dir, 6);
    expect(reopened.remaining('store.example')).toBe(3);
  });

  it('the window slides: a charge stops counting exactly 24 h after it was made', () => {
    expect(DIAG_BUDGET_WINDOW_MS).toBe(24 * HOUR);
    const c = clock();
    const b = open(tmpDir(), 2, c.now);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'a' }).charge(); // T0
    c.set(T0 + HOUR);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'b' }).charge(); // T0+1h
    c.set(T0 + 24 * HOUR - 1);
    expect(b.remaining('store.example')).toBe(0);
    c.set(T0 + 24 * HOUR);
    expect(b.remaining('store.example')).toBe(1);
    c.set(T0 + 25 * HOUR - 1);
    expect(b.remaining('store.example')).toBe(1);
    c.set(T0 + 25 * HOUR);
    expect(b.remaining('store.example')).toBe(2);
  });

  it('a charge inside the window is refused at the cap and allowed once the oldest charge has aged out', () => {
    const c = clock();
    const b = open(tmpDir(), 1, c.now);
    expect(b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'a' }).charge()).toBe(true);
    c.set(T0 + 24 * HOUR - 1);
    expect(b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'b' }).charge()).toBe(false);
    c.set(T0 + 24 * HOUR);
    expect(b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'c' }).charge()).toBe(true);
  });

  it('a charge stamped in the future (the clock stepped back) still counts', () => {
    const c = clock(T0 + 10 * HOUR);
    const b = open(tmpDir(), 2, c.now);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'a' }).charge();
    c.set(T0);
    expect(b.remaining('store.example')).toBe(1);
  });

  it('rows that can no longer count are pruned; rows still inside the window are kept', () => {
    const dir = tmpDir();
    const c = clock();
    const b = open(dir, 6, c.now);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'old' }).charge(); // T0
    c.set(T0 + 23 * HOUR);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'other.example', runId: 'mid' }).charge();
    c.set(T0 + 24 * HOUR);
    b.startCall({ probe: Probe.ROBOTS_SNAPSHOT, host: 'store.example', runId: 'new' }).charge();
    expect(rows(dir).map((r) => r.run_id)).toEqual(['mid', 'new']);
    expect(b.remaining('other.example')).toBe(5);
  });
});

describe('concurrent calls cannot overspend', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('ten interleaved async probes against one host charge exactly the cap, none beyond its own grant', async () => {
    const dir = tmpDir();
    const b = open(dir, 6);
    const spent = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        await tick();
        const call = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: `r${i}` });
        let n = 0;
        for (let k = 0; k < 3; k++) {
          await tick();
          if (call.charge()) n++;
        }
        expect(n).toBeLessThanOrEqual(call.granted);
        return n;
      })
    );
    expect(spent.reduce((a, n) => a + n, 0)).toBe(6);
    expect(rows(dir)).toHaveLength(6);
  });

  it('two handles on the same file see each other: the cap is read from disk, not from memory', () => {
    const dir = tmpDir();
    const a = open(dir, 2);
    const b = open(dir, 2);
    const callA = a.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'a' });
    const callB = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'b' });
    expect(callA.granted).toBe(2);
    expect(callB.granted).toBe(2);
    expect(callA.charge()).toBe(true);
    expect(callB.charge()).toBe(true);
    expect(callA.charge()).toBe(false);
    expect(callB.charge()).toBe(false);
    expect(rows(dir)).toHaveLength(2);
    expect(a.remaining('store.example')).toBe(0);
  });

  it('a storage failure throws from charge() — never a silent grant', () => {
    const b = open(tmpDir(), 6);
    const call = b.startCall({ probe: Probe.ITEM_STATUS, host: 'store.example', runId: 'r' });
    b.close();
    expect(() => call.charge()).toThrow();
    expect(call.spent).toBe(0);
  });
});
