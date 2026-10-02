/**
 * TDD (red first) — QB-U1: the scrape queue carries a lane per item.
 *
 * WHY: Ross (2026-09-29) splits MFC's one host slot between work classes (new, company, gap, and
 * 'other' for unlabelled work). The queue therefore has to (1) take an optional lane at enqueue,
 * (2) keep it on the row through every path an item travels, (3) settle two enqueues of the same URL
 * with different labels by a fixed rule, and (4) keep per-(host, class) depth that QB-U3's scheduler
 * and QB-U12's GetLaneDepth can read without a query. Dispatch itself does not change here.
 *
 * The coalesce rule (plan v2, design.scheduler.coalesce):
 *   existing lane null + incoming L  -> the row ADOPTS L            (relabeledLegacy)
 *   existing lane L + incoming M != L -> the first label is kept     (coalescedCrossLane)
 *   HOT rows are never relabeled.
 */
const mockNotifyItemFailed = jest.fn().mockResolvedValue(true);

jest.mock('../../services/genericScraper', () => ({
  BrowserPool: {
    getStealthBrowser: jest.fn(),
    getBrowser: jest.fn(),
    returnBrowser: jest.fn(),
    getPoolSize: jest.fn().mockReturnValue(2),
    getPoolCapacity: jest.fn().mockReturnValue(3),
    reset: jest.fn(),
  },
}));

jest.mock('../../services/webhookClient', () => ({
  notifyItemSuccess: jest.fn().mockResolvedValue(true),
  notifyItemFailed: (...args: any[]) => mockNotifyItemFailed(...args),
  notifyItemSkipped: jest.fn().mockResolvedValue(true),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ScrapeQueue, resetScrapeQueue, type QueueItem } from '../../services/scrapeQueue';
import { openQueueStore, QUEUE_DB_FILE, type ScrapeQueueStore } from '../../services/queueStore';
import { QUEUE_LANE_CLASSES, type QueueLane, type QueueLaneClass } from '../../services/queueLane';

const HOST = 'myfigurecollection.net';
const urlFor = (id: string, host = HOST) => `https://${host}/item/${id}`;

let dirs: string[] = [];
let stores: ScrapeQueueStore[] = [];
let queue: ScrapeQueue | undefined;

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-queue-lane-'));
  dirs.push(d);
  return d;
}

function openStore(dir: string): ScrapeQueueStore {
  const s = openQueueStore({ dir });
  stores.push(s);
  return s;
}

function wired(store?: ScrapeQueueStore): ScrapeQueue {
  queue = new ScrapeQueue(true);
  if (store) queue.setQueueStore(store);
  return queue;
}

/** The lane on disk for a dedup key, read through a separate read-only handle. */
function diskLane(dir: string, key: string): unknown {
  const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
  try {
    return (db.prepare('SELECT lane FROM queue_items WHERE mfc_id = ?').get(key) as unknown as { lane: unknown } | undefined)?.lane;
  } finally {
    db.close();
  }
}

type Internals = {
  hotQueue: QueueItem[];
  warmQueue: QueueItem[];
  coldQueue: QueueItem[];
  pendingItems: Map<string, QueueItem>;
  getNextProcessableItem(now: number): QueueItem | null;
  handleSuccess(item: QueueItem, result: unknown): void;
  handleFailure(item: QueueItem, error: Error): void;
};
const internals = (q: ScrapeQueue) => q as unknown as Internals;

/** Resident depth recounted from the tiers themselves — the truth the counters must match. */
function recountResident(q: ScrapeQueue, host: string): Record<QueueLaneClass, number> {
  const out = { new: 0, company: 0, gap: 0, other: 0 } as Record<QueueLaneClass, number>;
  const i = internals(q);
  for (const item of [...i.hotQueue, ...i.warmQueue, ...i.coldQueue]) {
    let h: string | undefined;
    try {
      h = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      h = undefined;
    }
    if (h === host) out[item.lane ?? 'other']++;
  }
  return out;
}

/** Parked depth recounted from the store — the truth the parked counters must match. */
function recountParked(store: ScrapeQueueStore, host: string): Record<QueueLaneClass, number> {
  const out = { new: 0, company: 0, gap: 0, other: 0 } as Record<QueueLaneClass, number>;
  for (const row of store.countByHostLane('parked')) if (row.host === host) out[row.lane ?? 'other'] += row.n;
  return out;
}

function depth(q: ScrapeQueue, host = HOST, field: 'resident' | 'parked' = 'resident'): Record<QueueLaneClass, number> {
  const counts = q.getLaneCounts(host);
  return Object.fromEntries(QUEUE_LANE_CLASSES.map((c) => [c, counts[c][field]])) as Record<QueueLaneClass, number>;
}

const Z = { new: 0, company: 0, gap: 0, other: 0 };

afterEach(() => {
  if (queue) {
    queue.stop();
    queue.clear();
    queue = undefined;
  }
  resetScrapeQueue();
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  stores = [];
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT;
  delete process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
describe('ScrapeQueue lane — enqueue takes an optional lane', () => {
  it('writes the lane through and reports it as the effective lane', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));

    const r = q.enqueue('a1', { url: urlFor('a1'), lane: 'new' });

    expect(r.lane).toBe('new');
    expect(diskLane(dir, 'a1')).toBe('new');
  });

  it('an unlabelled enqueue writes lane NULL and its result carries no lane at all', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));

    const r = q.enqueue('a1', { url: urlFor('a1') });

    expect('lane' in r).toBe(false);
    expect(diskLane(dir, 'a1')).toBeNull();
  });

  it.each([['other'], ['bogus'], ['']])('queues a label outside the vocabulary (%p) as unlabelled, with a warning', (bad) => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const r = q.enqueue('a1', { url: urlFor('a1'), lane: bad as QueueLane });

    expect('lane' in r).toBe(false);
    expect(diskLane(dir, 'a1')).toBeNull();
    expect(depth(q)).toEqual({ ...Z, other: 1 });
    expect(warn.mock.calls.filter((c) => /lane/.test(String(c[0])))).toHaveLength(1);
  });

  it('carries a lane per item through a bulk enqueue', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));

    q.enqueueBulk([
      { mfcId: 'b1', url: urlFor('b1'), lane: 'company' },
      { mfcId: 'b2', url: urlFor('b2'), lane: 'gap' },
      { mfcId: 'b3', url: urlFor('b3') },
    ]);

    expect([diskLane(dir, 'b1'), diskLane(dir, 'b2'), diskLane(dir, 'b3')]).toEqual(['company', 'gap', null]);
  });

  it('names the lane on the Enqueued log line only when there is one', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const q = wired();

    q.enqueue('a1', { url: urlFor('a1'), lane: 'gap' });
    q.enqueue('a2', { url: urlFor('a2') });

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[SCRAPE QUEUE] Enqueued'));
    expect(lines[0]).toMatch(/Enqueued a1 at priority WARM lane=gap \(queue size: 1\)$/);
    expect(lines[1]).toBe('[SCRAPE QUEUE] Enqueued a2 at priority WARM (queue size: 2)');
  });

  it('keeps the lane on the in-memory item when there is no durable store', () => {
    const q = wired();
    q.enqueue('a1', { url: urlFor('a1'), lane: 'company' });

    expect(internals(q).pendingItems.get('a1')?.lane).toBe('company');
    expect(depth(q)).toEqual({ ...Z, company: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('ScrapeQueue lane — (f) the coalesce rule', () => {
  it('null + L: the unlabelled row ADOPTS the incoming lane (relabeledLegacy)', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    q.enqueue('k', { url: urlFor('k') });

    const r = q.enqueue('k', { url: urlFor('k'), lane: 'company' });

    expect(r.deduplicated).toBe(true);
    expect(r.lane).toBe('company');
    expect(diskLane(dir, 'k')).toBe('company');
    expect(depth(q)).toEqual({ ...Z, company: 1 });
    const counts = q.getLaneCounts(HOST);
    expect(counts.company.relabeledLegacy).toBe(1);
    expect(counts.company.coalescedCrossLane).toBe(0);
  });

  it('L + L: nothing changes and nothing is counted', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    q.enqueue('k', { url: urlFor('k'), lane: 'gap' });

    const r = q.enqueue('k', { url: urlFor('k'), lane: 'gap' });

    expect(r.lane).toBe('gap');
    expect(diskLane(dir, 'k')).toBe('gap');
    expect(q.getLaneCounts(HOST).gap).toEqual({ resident: 1, parked: 0, relabeledLegacy: 0, coalescedCrossLane: 0 });
  });

  it('L + M: the first label is KEPT (coalescedCrossLane, counted against the kept lane)', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    q.enqueue('k', { url: urlFor('k'), lane: 'new' });

    const r = q.enqueue('k', { url: urlFor('k'), lane: 'gap' });

    expect(r.lane).toBe('new');
    expect(diskLane(dir, 'k')).toBe('new');
    expect(depth(q)).toEqual({ ...Z, new: 1 });
    const counts = q.getLaneCounts(HOST);
    expect(counts.new.coalescedCrossLane).toBe(1);
    expect(counts.gap.coalescedCrossLane).toBe(0);
    expect(counts.new.relabeledLegacy).toBe(0);
  });

  it('L + no label: the lane is kept and nothing is counted', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    q.enqueue('k', { url: urlFor('k'), lane: 'company' });

    const r = q.enqueue('k', { url: urlFor('k') });

    expect(r.lane).toBe('company');
    expect(diskLane(dir, 'k')).toBe('company');
    expect(q.getLaneCounts(HOST).company).toEqual({ resident: 1, parked: 0, relabeledLegacy: 0, coalescedCrossLane: 0 });
  });

  it('HOT + L: a HOT row is never relabeled, and nothing is counted', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    q.enqueue('k', { url: urlFor('k'), priority: 'HOT' });

    const r = q.enqueue('k', { url: urlFor('k'), lane: 'new' });

    expect('lane' in r).toBe(false);
    expect(diskLane(dir, 'k')).toBeNull();
    expect(depth(q)).toEqual({ ...Z, other: 1 });
    const counts = q.getLaneCounts(HOST);
    expect(counts.new.relabeledLegacy).toBe(0);
    expect(counts.other.coalescedCrossLane).toBe(0);
  });

  it('HOT L + M: a labelled HOT row keeps its lane and counts no cross-lane coalesce', () => {
    const q = wired(openStore(tmpDir()));
    q.enqueue('k', { url: urlFor('k'), priority: 'HOT', lane: 'company' });

    const r = q.enqueue('k', { url: urlFor('k'), lane: 'gap' });

    expect(r.lane).toBe('company');
    expect(q.getLaneCounts(HOST).company.coalescedCrossLane).toBe(0);
  });

  it('a PARKED unlabelled row is claimed and adopts the label, on disk and in the counters', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '1';
    const dir = tmpDir();
    const store = openStore(dir);
    const q = wired(store);
    q.enqueue('a0', { url: urlFor('a0') });
    q.enqueue('a1', { url: urlFor('a1') });
    expect(depth(q, HOST, 'parked')).toEqual({ ...Z, other: 1 });

    const r = q.enqueue('a1', { url: urlFor('a1'), lane: 'gap' });

    expect(r).toMatchObject({ deduplicated: true, lane: 'gap' });
    expect(diskLane(dir, 'a1')).toBe('gap');
    expect(depth(q, HOST, 'parked')).toEqual(Z);
    expect(depth(q)).toEqual({ ...Z, other: 1, gap: 1 });
    expect(q.getLaneCounts(HOST).gap.relabeledLegacy).toBe(1);
  });

  it('a row left by an OLDER build (lane null on disk) adopts the first label after a restart', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    first.put({ id: 'k-1', mfcId: 'k', url: urlFor('k'), priority: 'COLD', attempts: 1, maxRetries: 3, enqueuedAt: 1_000, state: 'pending' });
    first.close();
    const q = wired(openStore(dir));
    q.restoreFromStore(5_000);
    expect(depth(q)).toEqual({ ...Z, other: 1 });

    const r = q.enqueue('k', { url: urlFor('k'), priority: 'COLD', lane: 'company' });

    expect(r.lane).toBe('company');
    expect(diskLane(dir, 'k')).toBe('company');
    expect(depth(q)).toEqual({ ...Z, company: 1 });
  });

  it('an IN-FLIGHT unlabelled item adopts the label without moving resident depth it is not part of', () => {
    const dir = tmpDir();
    const q = wired(openStore(dir));
    q.enqueue('k', { url: urlFor('k') });
    const inFlight = internals(q).getNextProcessableItem(Date.now());
    expect(inFlight?.mfcId).toBe('k');
    expect(depth(q)).toEqual(Z);

    const r = q.enqueue('k', { url: urlFor('k'), lane: 'new' });

    expect(r.lane).toBe('new');
    expect(diskLane(dir, 'k')).toBe('new');
    expect(depth(q)).toEqual(Z);
    expect(q.getLaneCounts(HOST).new.relabeledLegacy).toBe(1);

    // If it fails and is re-queued, it comes back under the lane it adopted.
    internals(q).handleFailure(inFlight as QueueItem, new Error('NETWORK timeout reaching host'));
    expect(depth(q)).toEqual({ ...Z, new: 1 });
  });

  it('logs a relabel once, naming the lane the row adopted', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const q = wired();
    q.enqueue('k', { url: urlFor('k') });
    q.enqueue('k', { url: urlFor('k'), lane: 'gap' });
    q.enqueue('k', { url: urlFor('k'), lane: 'gap' });

    const relabels = log.mock.calls.map((c) => String(c[0])).filter((l) => /Relabeled/.test(l));
    expect(relabels).toEqual(['[SCRAPE QUEUE] Relabeled k: lane other -> gap (an unlabelled row adopts the first label)']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('ScrapeQueue lane — per-(host, lane) depth', () => {
  it('counts resident depth per host and class, and reads a www. host as the same host', () => {
    const q = wired(openStore(tmpDir()));
    q.enqueue('a', { url: urlFor('a'), lane: 'new' });
    q.enqueue('b', { url: urlFor('b', 'www.myfigurecollection.net'), lane: 'new' });
    q.enqueue('c', { url: urlFor('c'), lane: 'company', priority: 'COLD' });
    q.enqueue('d', { url: urlFor('d') });
    q.enqueue('e', { url: urlFor('e', 'other.example'), lane: 'gap' });
    q.enqueue('f', { url: 'not a url', lane: 'gap' });

    expect(depth(q)).toEqual({ new: 2, company: 1, gap: 0, other: 1 });
    expect(depth(q, 'www.MyFigureCollection.net')).toEqual({ new: 2, company: 1, gap: 0, other: 1 });
    expect(depth(q, 'other.example')).toEqual({ ...Z, gap: 1 });
  });

  it('counts overflow as parked depth and moves it to resident as it pages in', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '2';
    const store = openStore(tmpDir());
    const q = wired(store);
    q.enqueue('a0', { url: urlFor('a0'), lane: 'new' });
    q.enqueue('a1', { url: urlFor('a1'), lane: 'new' });
    q.enqueue('a2', { url: urlFor('a2'), lane: 'company' });
    q.enqueue('a3', { url: urlFor('a3') });
    expect(depth(q)).toEqual({ ...Z, new: 2 });
    expect(depth(q, HOST, 'parked')).toEqual({ ...Z, company: 1, other: 1 });

    q.cancel('a0');
    q.cancel('a1');
    expect(q.refillWorkingSet(Date.now())).toBe(2);

    expect(depth(q)).toEqual({ ...Z, company: 1, other: 1 });
    expect(depth(q, HOST, 'parked')).toEqual(Z);
    expect(internals(q).pendingItems.get('a2')?.lane).toBe('company');
  });

  it('a priority upgrade does not count an item twice', () => {
    const q = wired(openStore(tmpDir()));
    q.enqueue('k', { url: urlFor('k'), lane: 'gap', priority: 'COLD' });
    q.enqueue('k', { url: urlFor('k'), priority: 'WARM' });

    expect(depth(q)).toEqual({ ...Z, gap: 1 });
  });

  it('dispatch takes an item out of resident depth; a retry puts it back; success does not', () => {
    const q = wired(openStore(tmpDir()));
    q.enqueue('k1', { url: urlFor('k1'), lane: 'company' });
    q.enqueue('k2', { url: urlFor('k2', 'b.example'), lane: 'company' });

    const first = internals(q).getNextProcessableItem(Date.now()) as QueueItem;
    expect(depth(q).company + depth(q, 'b.example').company).toBe(1);
    internals(q).handleFailure(first, new Error('NETWORK timeout reaching host'));
    expect(depth(q).company + depth(q, 'b.example').company).toBe(2);

    const next = internals(q).getNextProcessableItem(Date.now() + 120_000) as QueueItem;
    internals(q).handleSuccess(next, {});
    expect(depth(q).company + depth(q, 'b.example').company).toBe(1);
  });

  it('cancel and clear take items out; clear forgets the coalesce counters too', () => {
    const q = wired(openStore(tmpDir()));
    q.enqueue('a', { url: urlFor('a'), lane: 'new' });
    q.enqueue('b', { url: urlFor('b') });
    q.enqueue('b', { url: urlFor('b'), lane: 'gap' });
    q.cancel('a');
    expect(depth(q)).toEqual({ ...Z, gap: 1 });

    q.clear();
    expect(q.getLaneCounts(HOST).gap).toEqual({ resident: 0, parked: 0, relabeledLegacy: 0, coalescedCrossLane: 0 });
  });

  it('is reconciled at BOOT: resident from the restored rows, parked from the disk', () => {
    const dir = tmpDir();
    const first = openStore(dir);
    const row = (id: string, state: 'pending' | 'parked', lane?: QueueLane) => ({
      id: `${id}-1`, mfcId: id, url: urlFor(id), priority: 'WARM' as const,
      attempts: 0, maxRetries: 3, enqueuedAt: 1_000, state, ...(lane ? { lane } : {}),
    });
    first.put(row('p1', 'pending', 'new'));
    first.put(row('p2', 'pending'));
    first.put(row('k1', 'parked', 'company'));
    first.put(row('k2', 'parked', 'company'));
    first.put(row('k3', 'parked', 'gap'));
    first.put({ ...row('l1', 'pending', 'gap') });
    first.lease('l1-1', 2_000);
    first.close();

    const q = wired(openStore(dir));
    // setQueueStore alone already knows what is parked on disk.
    expect(depth(q, HOST, 'parked')).toEqual({ ...Z, company: 2, gap: 1 });

    q.restoreFromStore(5_000);
    expect(depth(q)).toEqual({ ...Z, new: 1, other: 1, gap: 1 });
    expect(depth(q, HOST, 'parked')).toEqual({ ...Z, company: 2, gap: 1 });
  });

  it('never drifts from the tiers and the disk across a long mixed run', () => {
    process.env.SCRAPE_QUEUE_MAX_RESIDENT = '8';
    process.env.SCRAPE_QUEUE_MAX_RESIDENT_PER_HOST = '5';
    const store = openStore(tmpDir());
    const q = wired(store);
    const hosts = [HOST, 'www.myfigurecollection.net', 'b.example', 'c.example'];
    const lanes: Array<QueueLane | undefined> = ['new', 'company', 'gap', undefined];
    let seed = 0x5eed;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let now = Date.now();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    for (let step = 0; step < 600; step++) {
      const op = rnd(10);
      const key = `k${rnd(30)}`;
      if (op < 5) {
        const host = hosts[rnd(hosts.length)];
        const priority = (['WARM', 'COLD', 'HOT'] as const)[rnd(3)];
        const lane = lanes[rnd(lanes.length)];
        q.enqueue(key, { url: urlFor(key, host), priority, ...(lane ? { lane } : {}) });
      } else if (op < 6) {
        q.cancel(key);
      } else if (op < 9) {
        now += 60_000;
        const item = internals(q).getNextProcessableItem(now);
        if (item) {
          if (rnd(2) === 0) internals(q).handleSuccess(item, {});
          else internals(q).handleFailure(item, new Error('NETWORK timeout reaching host'));
        }
      } else {
        q.refillWorkingSet(now);
      }
      for (const host of [HOST, 'b.example', 'c.example']) {
        expect({ step, host, resident: depth(q, host) }).toEqual({ step, host, resident: recountResident(q, host) });
        expect({ step, host, parked: depth(q, host, 'parked') }).toEqual({ step, host, parked: recountParked(store, host) });
      }
    }
    log.mockRestore();
  });
});
