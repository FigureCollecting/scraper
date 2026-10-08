/**
 * runCrawlerPass — LISTS ALTERNATION RATIO (QB-U38; Ross MS-1 (c) 2026-10-07: in the lists window read Latest
 * Additions on ONE pass in THREE and company lists on the other TWO). `CRAWLER_LISTS_ALTERNATE=mfc:2:1` runs
 * two lists passes then one tap pass, repeating from the window's first pass (a lists pass); a bare `mfc`
 * keeps the 1:1 alternation, marker and all. Fake clock, memory (and file-over-memory-fs) stores, fake engine.
 */
import { createFileLedgerStore, createMemoryLedgerStore, type FsLike, type Ledger } from '../../crawler/ledger';
import { createFileListsStateStore, createMemoryListsStateStore, setListsGroup, type ListsState } from '../../crawler/listsState';
import { logger } from '../../utils/logger';
import { GROUP_COUNT, backlogState, iso, seedLedgers, simConfig, simulate, storeOf, type Call, type PassTrace } from '../helpers/crawlerAlternationSim';

const at = (day: number, hh: number, mm = 30): number => Date.parse(`2026-10-${String(6 + day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
const mfc = (p: PassTrace, kind?: Call['kind']): Call[] => p.calls.filter((c) => c.store === 'mfc' && (kind === undefined || c.kind === kind));
const marker = (lists: { files: Map<string, ListsState> }): unknown => (lists.files.get('mfc') as ListsState & { alternation?: unknown }).alternation;
const kinds = (passes: PassTrace[]): string[] => passes.map((p) => storeOf(p, 'mfc').alternation);
const steps = (passes: PassTrace[]): unknown[] => passes.map((p) => storeOf(p, 'mfc').alternationStep);
const twoToOne = { listsAlternate: ['mfc'], listsAlternateRatios: { mfc: { lists: 2, tap: 1 } } };

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('lists alternation ratio — mfc:2:1 over two nights of hourly passes', () => {
  const caps = { storeEnqueueCaps: { mfc: 10 } };
  const nightIdx = (day: number): number[] => [15, 16, 17, 18, 19, 20, 21].map((h) => day * 24 + h);
  let alt: Awaited<ReturnType<typeof simulate>>;
  let today: Awaited<ReturnType<typeof simulate>>;
  beforeAll(async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    alt = await simulate(simConfig({ ...caps, ...twoToOne }), { passes: 48 });
    today = await simulate(simConfig(caps), { passes: 48 });
    jest.restoreAllMocks();
  });

  it('each night runs L L T L L T L in the window, the first pass a lists pass, and 5 company groups, on BOTH nights', () => {
    for (const day of [0, 1]) {
      const night = nightIdx(day).map((i) => alt.passes[i]);
      expect(kinds(night)).toEqual(['lists', 'lists', 'tap', 'lists', 'lists', 'tap', 'lists']);
      expect(steps(night)).toEqual([1, 2, 3, 1, 2, 3, 1]);
      expect(night.map((p) => storeOf(p, 'mfc').listsGroup).filter((g) => g !== null)).toHaveLength(5);
    }
    expect(storeOf(alt.passes[nightIdx(0)[0]], 'mfc').listsGroup).toBe('c1');
    expect(storeOf(alt.passes[nightIdx(1)[0]], 'mfc').listsGroup).toBe('c6');
  });

  it('every in-window pass reports the ratio beside its phase; passes outside the window and other stores carry neither', () => {
    for (const p of alt.passes) {
      const s = storeOf(p, 'mfc');
      if (s.alternation === 'outside-window') {
        expect(s).not.toHaveProperty('alternationRatio');
        expect(s).not.toHaveProperty('alternationStep');
      } else {
        expect(s.alternationRatio).toBe('2:1');
      }
      for (const other of ['hpoi', 'orzgk']) {
        expect(storeOf(p, other)).not.toHaveProperty('alternationRatio');
        expect(storeOf(p, other)).not.toHaveProperty('alternationStep');
      }
    }
  });

  it('no pass ever issues an mfc listing GET (tap or backfill page) AND a company-list GET', () => {
    for (const p of alt.passes) expect(mfc(p, 'listing').length > 0 && mfc(p, 'list').length > 0).toBe(false);
  });

  it('a lists pass reads one group and no listing; a tap pass reads the listing and asks for no group', () => {
    for (const p of alt.passes) {
      const s = storeOf(p, 'mfc');
      if (s.alternation === 'lists') {
        expect(mfc(p, 'listing')).toEqual([]);
        expect(mfc(p, 'list')).toHaveLength(1);
      }
      if (s.alternation === 'tap') {
        expect(mfc(p, 'listing').map((c) => c.page)).toEqual([1, expect.any(Number)]);
        expect(mfc(p, 'decl')).toEqual([]);
        expect(s.listsSkipped).toBe('alternation-tap');
      }
    }
    expect(kinds(alt.passes).filter((k) => k === 'lists')).toHaveLength(10);
    expect(kinds(alt.passes).filter((k) => k === 'tap')).toHaveLength(4);
  });

  it('hpoi and the listing-only store make exactly the requests they make without the knob', () => {
    for (const [i, p] of alt.passes.entries()) {
      for (const store of ['hpoi', 'orzgk']) {
        expect(p.calls.filter((c) => c.store === store).map((c) => c.line)).toEqual(today.passes[i].calls.filter((c) => c.store === store).map((c) => c.line));
      }
    }
  });

  it('the marker carries the step of the last in-window pass', () => {
    expect(marker(alt.lists)).toEqual({ lastInWindowKind: 'lists', windowStart: '2026-10-07T15:30:00.000Z', at: '2026-10-07T21:30:00.000Z', step: 1 });
  });
});

describe('lists alternation ratio — the marker, pass by pass', () => {
  it('records the kind, the window start, the pass instant and the step on every in-window pass', async () => {
    const seen: unknown[] = [];
    const lists = createMemoryListsStateStore({ mfc: backlogState(10) });
    await simulate(simConfig(twoToOne), { passes: 4, from: at(0, 15), lists, beforePass: (i) => void (i > 0 && seen.push(marker(lists))) });
    seen.push(marker(lists));
    const w = '2026-10-06T15:30:00.000Z';
    expect(seen).toEqual([
      { lastInWindowKind: 'lists', windowStart: w, at: '2026-10-06T15:30:00.000Z', step: 1 },
      { lastInWindowKind: 'lists', windowStart: w, at: '2026-10-06T16:30:00.000Z', step: 2 },
      { lastInWindowKind: 'tap', windowStart: w, at: '2026-10-06T17:30:00.000Z', step: 3 },
      { lastInWindowKind: 'lists', windowStart: w, at: '2026-10-06T18:30:00.000Z', step: 1 },
    ]);
  });

  it('a NEW crawler process each pass continues the cycle from the file', async () => {
    const files = new Map<string, string>();
    const fs: FsLike = {
      readFile: async (p) => {
        const c = files.get(p);
        if (c === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return c;
      },
      writeFile: async (p, data) => void files.set(p, data),
      rename: async (from, to) => {
        files.set(to, files.get(from) as string);
        files.delete(from);
      },
      mkdir: async () => undefined,
    };
    for (const l of Object.values(seedLedgers()) as Ledger[]) await createFileLedgerStore('/ledgers', fs).save(l);
    await createFileListsStateStore('/ledgers', fs).save(backlogState(10));
    const { passes } = await simulate(simConfig(twoToOne), {
      passes: 7,
      from: at(0, 15),
      storesFor: (i) => ({ ledgerStore: createFileLedgerStore('/ledgers', fs, 100 + i), listsStore: createFileListsStateStore('/ledgers', fs, 100 + i) }),
    });
    expect(kinds(passes)).toEqual(['lists', 'lists', 'tap', 'lists', 'lists', 'tap', 'lists']);
  });

  it('a marker with no step (a 1:1 build wrote it) continues from its kind: lists = step 1, tap = the first tap step', async () => {
    const w = '2026-10-06T15:30:00.000Z';
    const cases: Array<[string, string[]]> = [
      ['lists', ['lists', 'tap', 'lists']],
      ['tap', ['lists', 'lists', 'tap']],
    ];
    for (const [last, expected] of cases) {
      const lists = createMemoryListsStateStore({ mfc: { ...backlogState(6), alternation: { lastInWindowKind: last, windowStart: w, at: w } } as unknown as ListsState });
      const { passes } = await simulate(simConfig(twoToOne), { passes: 3, from: at(0, 16), lists });
      expect(kinds(passes)).toEqual(expected);
    }
  });

  it('a stepless tap marker is the FIRST tap step: at 1:2 the next pass is the second tap step, not a wrap to lists', async () => {
    const w = '2026-10-06T15:30:00.000Z';
    const lists = createMemoryListsStateStore({ mfc: { ...backlogState(6), alternation: { lastInWindowKind: 'tap', windowStart: w, at: w } } as unknown as ListsState });
    const { passes } = await simulate(simConfig({ listsAlternate: ['mfc'], listsAlternateRatios: { mfc: { lists: 1, tap: 2 } } }), { passes: 3, from: at(0, 16), lists });
    expect(passes.map((p) => `${storeOf(p, 'mfc').alternation}@${storeOf(p, 'mfc').alternationStep}`)).toEqual(['tap@3', 'lists@1', 'tap@2']);
  });

  it('a malformed step is no step: the kind decides, and a malformed kind too opens the cycle', async () => {
    const w = '2026-10-06T15:30:00.000Z';
    for (const step of [0, -1, 2.5, '2', null, Number.NaN, 2 ** 53]) {
      const lists = createMemoryListsStateStore({ mfc: { ...backlogState(4), alternation: { lastInWindowKind: 'lists', windowStart: w, at: w, step } } as unknown as ListsState });
      const { passes } = await simulate(simConfig(twoToOne), { passes: 1, from: at(0, 16), lists });
      expect(storeOf(passes[0], 'mfc').alternationStep).toBe(2);
    }
    const lists = createMemoryListsStateStore({ mfc: { ...backlogState(4), alternation: { lastInWindowKind: 'list', windowStart: w, at: w } } as unknown as ListsState });
    const { passes } = await simulate(simConfig(twoToOne), { passes: 1, from: at(0, 16), lists });
    expect(storeOf(passes[0], 'mfc').alternationStep).toBe(1);
  });

  it('a step beyond the cycle (the ratio was shortened mid-window) wraps instead of stalling', async () => {
    const w = '2026-10-06T15:30:00.000Z';
    const lists = createMemoryListsStateStore({ mfc: { ...backlogState(6), alternation: { lastInWindowKind: 'tap', windowStart: w, at: w, step: 5 } } as unknown as ListsState });
    const { passes } = await simulate(simConfig(twoToOne), { passes: 2, from: at(0, 16), lists });
    expect(kinds(passes)).toEqual(['tap', 'lists']);
    expect(steps(passes)).toEqual([3, 1]);
  });

  it('a marker from an earlier night resets to step 1', async () => {
    const stale = { lastInWindowKind: 'lists', windowStart: '2026-10-05T15:30:00.000Z', at: '2026-10-05T21:30:00.000Z', step: 1 };
    const lists = createMemoryListsStateStore({ mfc: { ...backlogState(4), alternation: stale } as unknown as ListsState });
    const { passes } = await simulate(simConfig(twoToOne), { passes: 1, from: at(0, 15), lists });
    expect(steps(passes)).toEqual([1]);
    expect(kinds(passes)).toEqual(['lists']);
    // At 1:2 an earlier night's tap (the first tap step, 2) read as this window's would make the opener a tap.
    const staleTap = { lastInWindowKind: 'tap', windowStart: '2026-10-05T15:30:00.000Z', at: '2026-10-05T21:30:00.000Z' };
    const oneToTwo = createMemoryListsStateStore({ mfc: { ...backlogState(4), alternation: staleTap } as unknown as ListsState });
    const opener = await simulate(simConfig({ listsAlternate: ['mfc'], listsAlternateRatios: { mfc: { lists: 1, tap: 2 } } }), { passes: 1, from: at(0, 15), lists: oneToTwo });
    expect(kinds(opener.passes)).toEqual(['lists']);
  });
});

describe('lists alternation ratio — other ratios and the 1:1 default', () => {
  it('3:2 runs L L L T T L L across the seven in-window passes', async () => {
    const cfg = simConfig({ listsAlternate: ['mfc'], listsAlternateRatios: { mfc: { lists: 3, tap: 2 } } });
    const { passes } = await simulate(cfg, { passes: 7, from: at(0, 15), lists: createMemoryListsStateStore({ mfc: backlogState(20) }) });
    expect(kinds(passes)).toEqual(['lists', 'lists', 'lists', 'tap', 'tap', 'lists', 'lists']);
    expect(passes.map((p) => storeOf(p, 'mfc').alternationRatio)).toEqual(Array(7).fill('3:2'));
  });

  it('1:2 runs L T T L T T L: a window still opens with lists', async () => {
    const cfg = simConfig({ listsAlternate: ['mfc'], listsAlternateRatios: { mfc: { lists: 1, tap: 2 } } });
    const { passes } = await simulate(cfg, { passes: 7, from: at(0, 15), lists: createMemoryListsStateStore({ mfc: backlogState(20) }) });
    expect(kinds(passes)).toEqual(['lists', 'tap', 'tap', 'lists', 'tap', 'tap', 'lists']);
  });

  it('a bare store name is 1:1: L T L T L T L, the marker exactly as before (no step), the ratio reported as 1:1', async () => {
    const lists = createMemoryListsStateStore({ mfc: backlogState(20) });
    const { passes } = await simulate(simConfig({ listsAlternate: ['mfc'] }), { passes: 7, from: at(0, 15), lists });
    expect(kinds(passes)).toEqual(['lists', 'tap', 'lists', 'tap', 'lists', 'tap', 'lists']);
    expect(steps(passes)).toEqual([1, 2, 1, 2, 1, 2, 1]);
    expect(passes.map((p) => storeOf(p, 'mfc').alternationRatio)).toEqual(Array(7).fill('1:1'));
    expect(marker(lists)).toEqual({ lastInWindowKind: 'lists', windowStart: '2026-10-06T15:30:00.000Z', at: '2026-10-06T21:30:00.000Z' });
  });

  it('an explicit 1:1 is the bare name, request for request and state for state', async () => {
    const bare = await simulate(simConfig({ listsAlternate: ['mfc'] }), { passes: 24 });
    const explicit = await simulate(simConfig({ listsAlternate: ['mfc'], listsAlternateRatios: { mfc: { lists: 1, tap: 1 } } }), { passes: 24 });
    expect(explicit.passes.map((p) => p.calls.map((c) => c.line))).toEqual(bare.passes.map((p) => p.calls.map((c) => c.line)));
    expect(explicit.passes.map((p) => p.stores)).toEqual(bare.passes.map((p) => p.stores));
    expect([...explicit.lists.files.entries()]).toEqual([...bare.lists.files.entries()]);
  });

  it('a ratio for a store the knob does not alternate changes nothing', async () => {
    const plain = await simulate(simConfig(), { passes: 24 });
    const stray = await simulate(simConfig({ listsAlternateRatios: { mfc: { lists: 2, tap: 1 } } }), { passes: 24 });
    expect(stray.passes.map((p) => p.calls.map((c) => c.line))).toEqual(plain.passes.map((p) => p.calls.map((c) => c.line)));
    expect(stray.passes.map((p) => p.stores)).toEqual(plain.passes.map((p) => p.stores));
  });

  it('knob off: no store summary carries a ratio or a step', async () => {
    const { passes } = await simulate(simConfig(), { passes: 24 });
    for (const p of passes) {
      for (const s of p.stores) {
        expect(s).not.toHaveProperty('alternationRatio');
        expect(s).not.toHaveProperty('alternationStep');
      }
    }
  });
});

describe('lists alternation ratio — a lists pass that fetched no list', () => {
  it('falls back to the tap and keeps its step: the cycle does not slip', async () => {
    const spent = backlogState(10);
    for (let n = 1; n <= GROUP_COUNT; n++) {
      const t = iso(at(0, 14));
      setListsGroup(spent, `c${n}`, { lastAttemptAt: t, lastTriedAt: t, outcome: 'ok', seen: 3, new: 0, enqueued: 0, strikes: 0, retries: 0 });
    }
    const { passes } = await simulate(simConfig(twoToOne), { passes: 4, from: at(0, 15), lists: createMemoryListsStateStore({ mfc: spent }) });
    expect(kinds(passes)).toEqual(['fallback-tap', 'fallback-tap', 'tap', 'fallback-tap']);
    expect(steps(passes)).toEqual([1, 2, 3, 1]);
    expect(passes.map((p) => storeOf(p, 'mfc').alternationRatio)).toEqual(Array(4).fill('2:1'));
  });

  it('an unreadable lists state at pass start is off for the pass: no ratio, no step', async () => {
    const lists = createMemoryListsStateStore({ mfc: 'corrupt' });
    const { passes } = await simulate(simConfig(twoToOne), { passes: 1, from: at(0, 15), lists, ledgers: createMemoryLedgerStore(seedLedgers()) });
    expect(storeOf(passes[0], 'mfc').alternation).toBe('off');
    expect(storeOf(passes[0], 'mfc')).not.toHaveProperty('alternationRatio');
    expect(warn).toHaveBeenCalled();
  });
});
