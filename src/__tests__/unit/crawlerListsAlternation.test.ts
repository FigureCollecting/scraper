/**
 * runCrawlerPass — LISTS ALTERNATION (QB-U21; Ross MS 2026-10-04: "slow to 7s if we can't alternate runs
 * between latest additions page and company yet"). For a store named in CRAWLER_LISTS_ALTERNATE, a pass
 * that STARTS inside CRAWLER_LISTS_WINDOW_UTC fetches EITHER the Latest Additions tap OR one company-list
 * group, never both; every window opens with a lists pass, so the 7 in-window :30 passes run L T L T L T L.
 * Fake clock, memory (and file-over-memory-fs) stores, and a fake engine recording every request.
 */
import * as fsNode from 'fs';
import * as path from 'path';
import { runCrawlerPass } from '../../crawler/crawler';
import { createFileLedgerStore, createMemoryLedgerStore, type FsLike, type Ledger } from '../../crawler/ledger';
import { createFileListsStateStore, createMemoryListsStateStore, setListsGroup, type ListsState, type ListsStateStore } from '../../crawler/listsState';
import { logger } from '../../utils/logger';
import {
  GROUP_COUNT,
  backlogState,
  clock,
  goldenTrace,
  iso,
  makeEngine,
  seedLedgers,
  simConfig,
  simulate,
  storeOf,
  type Call,
  type PassTrace,
} from '../helpers/crawlerAlternationSim';

/** Recorded from upstream develop 1afae8ba (before this change) with the same simulation. */
const GOLDEN = JSON.parse(fsNode.readFileSync(path.join(__dirname, '../fixtures/crawler/listsAlternationGolden.json'), 'utf8'));

const at = (day: number, hh: number, mm = 30): number => Date.parse(`2026-10-${String(6 + day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
const mfc = (p: PassTrace, kind?: Call['kind']): Call[] => p.calls.filter((c) => c.store === 'mfc' && (kind === undefined || c.kind === kind));
/** Posts of the lists drain: the backlog's 90000+ ids and the company lists' 50000+ ids (never a listing or range id). */
const drainPosts = (p: PassTrace): Call[] => mfc(p, 'post').filter((c) => Number(c.line.split('/').pop()?.split(' ')[0]) >= 50_000);
const linesOf = (p: PassTrace, store: string): string[] => p.calls.filter((c) => c.store === store).map((c) => c.line);
const marker = (lists: { files: Map<string, ListsState> }): unknown => (lists.files.get('mfc') as ListsState & { alternation?: unknown }).alternation;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const alternationWarns = (): unknown[][] => warn.mock.calls.filter((c) => String(c[0]).includes('CRAWLER_LISTS_ALTERNATE') || String(c[0]).includes('alternation'));

describe('lists alternation — knob empty is today, request for request', () => {
  it('no knob at all: 24 h of :30 passes make the same requests, ledgers and lists state as upstream develop', async () => {
    expect(await goldenTrace(simConfig())).toEqual(GOLDEN);
  });

  it('an empty knob is the same pass', async () => {
    expect(await goldenTrace(simConfig({ listsAlternate: [] }))).toEqual(GOLDEN);
  });

  it('a knob naming only stores with no lists step changes nothing, with one WARN per store per pass', async () => {
    expect(await goldenTrace(simConfig({ listsAlternate: ['hpoi', 'orzgk', 'ghost'] }))).toEqual(GOLDEN);
    const named = alternationWarns().map((c) => (c[1] as { siteId: string }).siteId);
    expect(named).toHaveLength(3 * 24);
    expect(named.slice(0, 3)).toEqual(['hpoi', 'orzgk', 'ghost']);
  });

  it('every store summary reads alternation off when the knob is empty', async () => {
    const { passes } = await simulate(simConfig(), { passes: 1, from: at(0, 16) });
    expect(passes[0].stores.map((s) => s.alternation)).toEqual(['off', 'off', 'off']);
  });

  it('a mode that does not run both recent and backfill ignores the knob with a WARN and runs the lists as today', async () => {
    const cfg = simConfig({ mode: 'backfill', phases: ['backfill'], listsAlternate: ['mfc'] });
    const { passes } = await simulate(cfg, { passes: 1, from: at(0, 16) });
    expect(storeOf(passes[0], 'mfc').alternation).toBe('off');
    expect(mfc(passes[0], 'list')).toHaveLength(1);
    expect(alternationWarns()).toHaveLength(1);
    expect(alternationWarns()[0][1]).toEqual(expect.objectContaining({ siteId: 'mfc' }));
  });
});

describe('lists alternation — mfc over two nights of hourly passes', () => {
  const cfg = simConfig({ listsAlternate: ['mfc'] });
  const nightIdx = (day: number): number[] => [15, 16, 17, 18, 19, 20, 21].map((h) => day * 24 + h);
  let alt: Awaited<ReturnType<typeof simulate>>;
  let today: Awaited<ReturnType<typeof simulate>>;
  beforeAll(async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    alt = await simulate(cfg, { passes: 48 });
    today = await simulate(simConfig(), { passes: 48 });
    jest.restoreAllMocks();
  });

  it('each night runs L T L T L T L in the window, and 4 company groups, on BOTH nights', () => {
    for (const day of [0, 1]) {
      const kinds = nightIdx(day).map((i) => storeOf(alt.passes[i], 'mfc').alternation);
      expect(kinds).toEqual(['lists', 'tap', 'lists', 'tap', 'lists', 'tap', 'lists']);
      const groups = nightIdx(day).map((i) => storeOf(alt.passes[i], 'mfc').listsGroup).filter((g) => g !== null);
      expect(groups).toHaveLength(4);
    }
    expect(storeOf(alt.passes[nightIdx(0)[0]], 'mfc').listsGroup).toBe('c1');
    expect(storeOf(alt.passes[nightIdx(1)[0]], 'mfc').listsGroup).toBe('c5');
  });

  it('no pass ever issues an mfc listing GET (tap or backfill page) AND a company-list GET', () => {
    for (const p of alt.passes) {
      expect(mfc(p, 'listing').length > 0 && mfc(p, 'list').length > 0).toBe(false);
    }
  });

  it('a lists pass skips the tap AND the backfill page; a tap pass skips the declaration and every list', () => {
    const kinds = alt.passes.map((p) => storeOf(p, 'mfc').alternation);
    expect(kinds.filter((k) => k === 'lists')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'tap')).toHaveLength(6);
    for (const p of alt.passes) {
      const s = storeOf(p, 'mfc');
      if (s.alternation === 'lists') {
        expect(mfc(p, 'listing')).toEqual([]);
        expect(mfc(p, 'decl')).toHaveLength(1);
        expect(mfc(p, 'list')).toHaveLength(1);
        expect(s.listsSkipped).toBeNull();
      }
      if (s.alternation === 'tap') {
        expect(mfc(p, 'listing').map((c) => c.page)).toEqual([1, expect.any(Number)]);
        expect(mfc(p, 'listing')[1].page).toBeGreaterThan(1);
        expect(mfc(p, 'decl')).toEqual([]);
        expect(mfc(p, 'list')).toEqual([]);
        expect(s.listsSkipped).toBe('alternation-tap');
      }
    }
  });

  it('outside the window the tap runs every pass and the rotation is never asked', () => {
    const outside = alt.passes.filter((p) => storeOf(p, 'mfc').alternation === 'outside-window');
    expect(outside).toHaveLength(48 - 14);
    for (const p of outside) {
      expect(mfc(p, 'listing')[0]?.page).toBe(1);
      expect(mfc(p, 'decl')).toEqual([]);
      expect(mfc(p, 'list')).toEqual([]);
      expect(storeOf(p, 'mfc').listsSkipped).toBe('outside-window');
    }
  });

  it('the drain posts COLD on lists passes, tap passes and outside the window', () => {
    for (const kind of ['lists', 'tap', 'outside-window']) {
      const passes = alt.passes.filter((p) => storeOf(p, 'mfc').alternation === kind);
      expect(passes.length).toBeGreaterThan(0);
      for (const p of passes) {
        expect(drainPosts(p).length).toBeGreaterThan(0);
        expect(drainPosts(p).every((c) => c.line.endsWith(' COLD'))).toBe(true);
      }
    }
  });

  it('hpoi and the listing-only store make exactly the requests and keep exactly the ledgers they do today', () => {
    for (const [i, p] of alt.passes.entries()) {
      expect(linesOf(p, 'hpoi')).toEqual(linesOf(today.passes[i], 'hpoi'));
      expect(linesOf(p, 'orzgk')).toEqual(linesOf(today.passes[i], 'orzgk'));
      expect(storeOf(p, 'hpoi').alternation).toBe('off');
      expect(storeOf(p, 'orzgk').alternation).toBe('off');
    }
    expect(alt.ledgers.files.get('hpoi')).toEqual(today.ledgers.files.get('hpoi'));
    expect(alt.ledgers.files.get('orzgk')).toEqual(today.ledgers.files.get('orzgk'));
  });

  it('the marker is the last in-window pass, kept untouched by the passes outside the window', () => {
    expect(marker(alt.lists)).toEqual({ lastInWindowKind: 'lists', windowStart: '2026-10-07T15:30:00.000Z', at: '2026-10-07T21:30:00.000Z' });
  });
});

describe('lists alternation — the marker, pass by pass', () => {
  it('records the intended kind, the window start and the pass instant on every in-window pass', async () => {
    const seen: unknown[] = [];
    const lists = createMemoryListsStateStore({ mfc: backlogState(10) });
    await simulate(simConfig({ listsAlternate: ['mfc'] }), {
      passes: 4,
      from: at(0, 14),
      lists,
      beforePass: (i) => {
        if (i > 0) seen.push(marker(lists));
      },
    });
    seen.push(marker(lists));
    expect(seen).toEqual([
      undefined,
      { lastInWindowKind: 'lists', windowStart: '2026-10-06T15:30:00.000Z', at: '2026-10-06T15:30:00.000Z' },
      { lastInWindowKind: 'tap', windowStart: '2026-10-06T15:30:00.000Z', at: '2026-10-06T16:30:00.000Z' },
      { lastInWindowKind: 'lists', windowStart: '2026-10-06T15:30:00.000Z', at: '2026-10-06T17:30:00.000Z' },
    ]);
  });
});

describe('lists alternation — a lists pass that fetched no list falls back to the tap', () => {
  const cfg = simConfig({ listsAlternate: ['mfc'] });
  const allSpent = (): ListsState => {
    const s = backlogState(10);
    for (let n = 1; n <= GROUP_COUNT; n++) {
      const t = iso(at(0, 14));
      setListsGroup(s, `c${n}`, { lastAttemptAt: t, lastTriedAt: t, outcome: 'ok', seen: 3, new: 0, enqueued: 0, strikes: 0, retries: 0 });
    }
    return s;
  };

  it('none-due: the tap runs AFTER the lists step, the backfill page does not, and the next pass is a tap pass', async () => {
    const lists = createMemoryListsStateStore({ mfc: allSpent() });
    const { passes } = await simulate(cfg, { passes: 3, from: at(0, 15), lists });
    const [first, second, third] = passes;
    expect(storeOf(first, 'mfc').alternation).toBe('fallback-tap');
    expect(storeOf(first, 'mfc').listsSkipped).toBe('none-due');
    expect(mfc(first, 'list')).toEqual([]);
    expect(mfc(first, 'listing').map((c) => c.page)).toEqual([1]);
    const decl = first.calls.findIndex((c) => c.store === 'mfc' && c.kind === 'decl');
    const tap = first.calls.findIndex((c) => c.store === 'mfc' && c.kind === 'listing');
    expect(decl).toBeGreaterThanOrEqual(0);
    expect(tap).toBeGreaterThan(decl);
    expect(storeOf(first, 'mfc').recentPages).toBe(1);
    expect(storeOf(second, 'mfc').alternation).toBe('tap');
    expect(storeOf(third, 'mfc').alternation).toBe('fallback-tap');
  });

  it('paused: no rotation request at all, the tap runs, and the marker still records a lists pass', async () => {
    const paused = { ...backlogState(10), pausedUntil: '2026-10-06T22:30:00.000Z' };
    const lists = createMemoryListsStateStore({ mfc: paused });
    const { passes } = await simulate(cfg, { passes: 2, from: at(0, 15), lists });
    expect(storeOf(passes[0], 'mfc').alternation).toBe('fallback-tap');
    expect(storeOf(passes[0], 'mfc').listsSkipped).toBe('paused');
    expect(mfc(passes[0], 'decl')).toEqual([]);
    expect(mfc(passes[0], 'listing').map((c) => c.page)).toEqual([1]);
    expect(storeOf(passes[1], 'mfc').alternation).toBe('tap');
    expect(marker(lists)).toEqual(expect.objectContaining({ lastInWindowKind: 'tap' }));
  });

  it('unsupported (the engine has no rotating route): the tap runs', async () => {
    const { passes } = await simulate(cfg, { passes: 1, from: at(0, 15), engine: { decl: () => ({ status: 404, body: { error: 'not found' } }) } });
    expect(storeOf(passes[0], 'mfc').alternation).toBe('fallback-tap');
    expect(storeOf(passes[0], 'mfc').listsSkipped).toBe('unsupported');
    expect(mfc(passes[0], 'listing')).toHaveLength(1);
  });

  it('a list fetch that FAILED still costs the tap: the store keeps walking, but no listing GET this pass', async () => {
    const failing = () => ({ status: 502, body: { error: 'catalog failed', siteId: 'mfc', reason: 'parser threw', failure: 'deterministic' } });
    const { passes } = await simulate(cfg, { passes: 1, from: at(0, 15), engine: { list: failing } });
    const s = storeOf(passes[0], 'mfc');
    expect(s.alternation).toBe('lists');
    expect(s.listsFailed).toBe(1);
    expect(mfc(passes[0], 'list')).toHaveLength(1);
    expect(mfc(passes[0], 'listing')).toEqual([]);
    // Not stopped: the descent below the lists still asked for its window.
    expect(mfc(passes[0], 'range')).toHaveLength(1);
  });

  it('a declaration that failed stops the store, so there is no tap either', async () => {
    const { passes } = await simulate(cfg, { passes: 1, from: at(0, 15), engine: { decl: () => ({ status: 500, body: {} }) } });
    expect(storeOf(passes[0], 'mfc').alternation).toBe('lists');
    expect(storeOf(passes[0], 'mfc').listsSkipped).toBe('failed');
    expect(mfc(passes[0], 'listing')).toEqual([]);
  });
});

describe('lists alternation — restarts and the state other builds write', () => {
  const memFs = () => {
    const files = new Map<string, string>();
    const fs: FsLike = {
      async readFile(p) {
        const c = files.get(p);
        if (c === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return c;
      },
      async writeFile(p, data) {
        files.set(p, data);
      },
      async rename(from, to) {
        files.set(to, files.get(from) as string);
        files.delete(from);
      },
      async mkdir() {
        return undefined;
      },
    };
    return { fs, files };
  };
  const seedFiles = async (fs: FsLike, lists: ListsState = backlogState(10)): Promise<void> => {
    for (const l of Object.values(seedLedgers()) as Ledger[]) await createFileLedgerStore('/ledgers', fs).save(l);
    await createFileListsStateStore('/ledgers', fs).save(lists);
  };
  const readMarker = (files: Map<string, string>): unknown => JSON.parse(files.get('/ledgers/mfc.lists.json') as string).alternation;

  it('a NEW crawler process mid-window continues the alternation from the file', async () => {
    const { fs } = memFs();
    await seedFiles(fs);
    const { passes } = await simulate(simConfig({ listsAlternate: ['mfc'] }), {
      passes: 4,
      from: at(0, 15),
      // Every pass is a fresh process: new store objects over the same files.
      storesFor: (i) => ({ ledgerStore: createFileLedgerStore('/ledgers', fs, 100 + i), listsStore: createFileListsStateStore('/ledgers', fs, 100 + i) }),
    });
    expect(passes.map((p) => storeOf(p, 'mfc').alternation)).toEqual(['lists', 'tap', 'lists', 'tap']);
  });

  it('a lists state written by today\'s code (no marker) loads, and the first in-window pass, mid-window, is a lists pass', async () => {
    const { fs } = memFs();
    const todays = backlogState(10);
    setListsGroup(todays, 'c1', { lastAttemptAt: iso(at(0, 15)), lastTriedAt: iso(at(0, 15)), outcome: 'ok', seen: 3, new: 3, enqueued: 0, strikes: 0, retries: 0 });
    await seedFiles(fs, todays);
    const { passes } = await simulate(simConfig({ listsAlternate: ['mfc'] }), {
      passes: 2,
      from: at(0, 18),
      storesFor: () => ({ ledgerStore: createFileLedgerStore('/ledgers', fs), listsStore: createFileListsStateStore('/ledgers', fs) }),
    });
    expect(passes.map((p) => storeOf(p, 'mfc').alternation)).toEqual(['lists', 'tap']);
    expect(storeOf(passes[0], 'mfc').listsGroup).toBe('c2');
  });

  it('a build without the knob (an older one, or the knob unset) keeps the marker through its own load and save', async () => {
    const { fs, files } = memFs();
    await seedFiles(fs);
    const stores = () => ({ ledgerStore: createFileLedgerStore('/ledgers', fs), listsStore: createFileListsStateStore('/ledgers', fs) });
    // 15:30 with the knob writes the marker.
    await simulate(simConfig({ listsAlternate: ['mfc'] }), { passes: 1, from: at(0, 15), storesFor: stores });
    const written = readMarker(files);
    expect(written).toEqual({ lastInWindowKind: 'lists', windowStart: '2026-10-06T15:30:00.000Z', at: '2026-10-06T15:30:00.000Z' });
    // A bare load + save (coerceListsState returns the document as it is), then a whole pass without the knob.
    const older = createFileListsStateStore('/ledgers', fs, 999);
    const loaded = await older.load('mfc');
    expect(loaded).not.toBe('corrupt');
    await older.save(loaded as ListsState);
    const plain = await simulate(simConfig(), { passes: 1, from: at(0, 16), storesFor: stores });
    expect(storeOf(plain.passes[0], 'mfc').listsGroup).toBe('c2');
    expect(readMarker(files)).toEqual(written);
    // Back on the knob at 17:30: the marker says the last in-window pass was lists, so this one taps.
    const back = await simulate(simConfig({ listsAlternate: ['mfc'] }), { passes: 1, from: at(0, 17), storesFor: stores });
    expect(storeOf(back.passes[0], 'mfc').alternation).toBe('tap');
  });

  it('a malformed marker is no marker: the pass is a lists pass, the state is not refused, and the marker is rewritten', async () => {
    for (const junk of [{ lastInWindowKind: 'list', windowStart: '2026-10-06T15:30:00.000Z', at: 'x' }, { lastInWindowKind: 'lists', windowStart: 'yesterday' }, 'lists', null]) {
      const lists = createMemoryListsStateStore({ mfc: { ...backlogState(4), alternation: junk } as unknown as ListsState });
      const { passes } = await simulate(simConfig({ listsAlternate: ['mfc'] }), { passes: 1, from: at(0, 17), lists });
      expect(storeOf(passes[0], 'mfc').alternation).toBe('lists');
      expect(storeOf(passes[0], 'mfc').listsSkipped).toBeNull();
      expect(marker(lists)).toEqual({ lastInWindowKind: 'lists', windowStart: '2026-10-06T15:30:00.000Z', at: '2026-10-06T17:30:00.000Z' });
    }
  });

  it('a marker from an earlier night resets: the window opens with a lists pass whatever the last kind was', async () => {
    const stale = { lastInWindowKind: 'lists', windowStart: '2026-10-05T15:30:00.000Z', at: '2026-10-05T21:30:00.000Z' };
    const lists = createMemoryListsStateStore({ mfc: { ...backlogState(4), alternation: stale } as unknown as ListsState });
    const { passes } = await simulate(simConfig({ listsAlternate: ['mfc'] }), { passes: 2, from: at(0, 15), lists });
    expect(passes.map((p) => storeOf(p, 'mfc').alternation)).toEqual(['lists', 'tap']);
  });
});

describe('lists alternation — a window that wraps midnight', () => {
  it('21:00-02:00: the 00:30 and 01:30 passes belong to the window that opened the evening before, and the next evening resets', async () => {
    const cfg = simConfig({ listsAlternate: ['mfc'], listsWindow: { startMin: 21 * 60, endMin: 2 * 60 } });
    const starts = [at(0, 21), at(0, 22), at(0, 23), at(1, 0), at(1, 1), at(1, 2), at(1, 21), at(1, 22)];
    const seen: unknown[] = [];
    const lists = createMemoryListsStateStore({ mfc: backlogState(20) });
    const { passes } = await simulate(cfg, { passes: starts.length, at: starts, lists, beforePass: (i) => void (i === 5 && seen.push(marker(lists))) });
    expect(passes.map((p) => storeOf(p, 'mfc').alternation)).toEqual(['lists', 'tap', 'lists', 'tap', 'lists', 'outside-window', 'lists', 'tap']);
    expect(seen[0]).toEqual({ lastInWindowKind: 'lists', windowStart: '2026-10-06T21:00:00.000Z', at: '2026-10-07T01:30:00.000Z' });
  });
});

describe('lists alternation — a pass that starts outside the window', () => {
  it('fetches no list even when a slow tap carries it into the window (never both in one pass)', async () => {
    const run = async (listsAlternate: string[]) => {
      const c = clock(at(0, 15, 29) + 45_000);
      const engine = makeEngine(c.now, { onListing: (store, page) => void (store === 'mfc' && page === 1 && c.advance(30_000)) });
      const summary = await runCrawlerPass(simConfig({ listsAlternate }), {
        fetch: engine.fetch,
        ledgerStore: createMemoryLedgerStore(seedLedgers()),
        listsStore: createMemoryListsStateStore({ mfc: backlogState(4) }),
        now: c.now,
        sleep: c.sleep,
      });
      return { calls: engine.calls.filter((x) => x.store === 'mfc'), s: summary.stores[0] };
    };
    // Today: the tap at 15:29:45 and, 30 s later, inside the window, a company list in the same pass.
    const before = await run([]);
    expect(before.calls.some((x) => x.kind === 'listing') && before.calls.some((x) => x.kind === 'list')).toBe(true);
    const after = await run(['mfc']);
    expect(after.s.alternation).toBe('outside-window');
    expect(after.s.listsSkipped).toBe('outside-window');
    expect(after.calls.filter((x) => x.kind === 'decl' || x.kind === 'list')).toEqual([]);
    expect(after.calls.filter((x) => x.kind === 'listing')).toHaveLength(2);
  });
});

describe('lists alternation — a lists state that cannot be read at pass start', () => {
  const passesFrom15 = { passes: 3, from: at(0, 15) };

  it('corrupt: the store runs exactly as today (alternation off), with one WARN per pass', async () => {
    const run = (listsAlternate: string[]) =>
      simulate(simConfig({ listsAlternate }), { ...passesFrom15, lists: createMemoryListsStateStore({ mfc: 'corrupt' }) });
    const before = await run([]);
    warn.mockClear();
    const after = await run(['mfc']);
    for (const [i, p] of after.passes.entries()) {
      expect(p.calls.map((c) => c.line)).toEqual(before.passes[i].calls.map((c) => c.line));
      expect(storeOf(p, 'mfc').alternation).toBe('off');
      expect(storeOf(p, 'mfc').listsSkipped).toBe('state-corrupt');
    }
    expect(alternationWarns()).toHaveLength(3);
  });

  it('a load that throws at pass start: alternation off and today\'s pass, the lists step included', async () => {
    const flaky = (): ListsStateStore & { failNext: boolean } => {
      const inner = createMemoryListsStateStore({ mfc: backlogState(10) });
      const store = {
        failNext: false,
        load: async (siteId: string) => {
          if (store.failNext) {
            store.failNext = false;
            throw new Error('EIO');
          }
          return inner.load(siteId);
        },
        save: (s: ListsState) => inner.save(s),
      };
      return store;
    };
    const before = await simulate(simConfig(), { ...passesFrom15, lists: createMemoryListsStateStore({ mfc: backlogState(10) }) });
    const store = flaky();
    const ledgers = createMemoryLedgerStore(seedLedgers());
    warn.mockClear();
    const after = await simulate(simConfig({ listsAlternate: ['mfc'] }), {
      ...passesFrom15,
      storesFor: () => ({ ledgerStore: ledgers, listsStore: store }),
      beforePass: () => {
        store.failNext = true;
      },
    });
    for (const [i, p] of after.passes.entries()) {
      expect(p.calls.map((c) => c.line)).toEqual(before.passes[i].calls.map((c) => c.line));
      expect(storeOf(p, 'mfc').alternation).toBe('off');
    }
    expect(alternationWarns()).toHaveLength(3);
  });

  it('a store the pass does not run (pulled out, or a corrupt ledger) is not alternated and its lists state is not opened', async () => {
    const lists = createMemoryListsStateStore({ mfc: backlogState(4) });
    const load = jest.spyOn(lists, 'load');
    const out = await simulate(simConfig({ listsAlternate: ['mfc'], storeEnqueueCaps: { mfc: 0 } }), { passes: 1, from: at(0, 16), lists });
    expect(storeOf(out.passes[0], 'mfc').alternation).toBe('off');
    const corrupt = await simulate(simConfig({ listsAlternate: ['mfc'] }), {
      passes: 1,
      from: at(0, 16),
      lists,
      ledgers: createMemoryLedgerStore({ ...seedLedgers(), mfc: 'corrupt' }),
    });
    expect(storeOf(corrupt.passes[0], 'mfc').alternation).toBe('off');
    expect(load).not.toHaveBeenCalled();
    expect(mfc(out.passes[0])).toEqual([]);
  });
});
