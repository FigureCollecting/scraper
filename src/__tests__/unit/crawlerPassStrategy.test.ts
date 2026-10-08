/**
 * runCrawlerPass — PASS-STRATEGY OBSERVABILITY (QB-U36 parts A and B; Ross MS-1 2026-10-07: assess the 2:1 trial).
 * For a store in CRAWLER_LISTS_ALTERNATE every pass adds the strategy fields to the store summary, logs ONE
 * `[CRAWLER] pass-strategy {json}` line (strategyVersion 1) and appends that record to the store's ring file.
 * Fake engine (no request reaches any store), fake clock, a stub hostClock block, a memory ring.
 */
import { createEmptyLedger, createMemoryLedgerStore, type Ledger } from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import { runCrawlerPass, type CrawlerConfig, type CrawlerStoreSummary } from '../../crawler/crawler';
import { PASS_STRATEGY_VERSION, type PassRingStore, type PassStrategyRecord } from '../../crawler/passStrategy';
import { logger } from '../../utils/logger';
import { DAY0, HOUR_MS, clock, iso, itemUrl, makeEngine, simConfig, type Call, type Reply } from '../helpers/crawlerAlternationSim';

/** Three companies, two lists each (domain 9 then 1), named the way the mfc ruleset names them. */
const COMPANIES = ['7620', '7721', '8800'];
const DECL3 = COMPANIES.flatMap((entryId, i) =>
  [9, 1].map((d) => ({ id: `company-${entryId}-d${d}`, url: `https://mfc.test/s?e=${entryId}&d=${d}`, group: entryId, order: i + 1 })),
);

const items = (ids: number[]): Array<{ itemId: string; collectUrl?: string }> => ids.map((id) => ({ itemId: String(id), collectUrl: itemUrl('mfc', id) }));
const ok = (list: Array<{ itemId: string; collectUrl?: string }>): Reply => ({ status: 200, body: { siteId: 'mfc', items: list, hasMore: false, count: list.length } });
const CHALLENGE_LIST: Reply = { status: 502, body: { error: 'catalog failed', siteId: 'mfc', failure: 'deterministic', blocked: true, reason: 'challenge page', upstreamStatus: 403 } };
const COOLDOWN: Reply = { status: 503, body: { error: 'cooldown', siteId: 'mfc', host: 'mfc.test', remainingMs: 60_000 } };
const CHALLENGE_PAGE: Reply = { status: 502, body: { error: 'catalog failed', siteId: 'mfc', reason: 'challenge page' } };

/** Company 7620: d9 offers 1001-1003 (+ an id with no url), d1 offers 1003-1004: union 4, 1002 already known. */
const LISTS: Record<string, Reply> = {
  'company-7620-d9': ok([...items([1001, 1002, 1003]), { itemId: '1009' }]),
  'company-7620-d1': ok(items([1003, 1004])),
  'company-7721-d9': CHALLENGE_LIST,
  'company-7721-d1': ok(items([1100])),
  'company-8800-d9': ok(items([1200])),
  'company-8800-d1': ok(items([1201])),
};

const sends = (over: Record<string, number> = {}): Record<string, number> => ({
  queue: 0, image: 0, catalogListing: 0, catalogSeed: 0, catalogRotating: 0, resolve: 0, scrape: 0, lookup: 0, fetchBody: 0, sessionPrime: 0, pluginRoute: 0, ...over,
});
const hostView = (host: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  host,
  floorMs: 7000,
  clocked: true,
  sends60m: sends({ queue: 4, catalogListing: 2, catalogRotating: 2 }),
  minGapMs60m: 7012,
  underFloor60m: 1,
  constrainedGaps60m: 3,
  meanConstrainedGapMs60m: 7500,
  clockRefusals60m: sends(),
  listingFetchP99Ms60m: 1800,
  lookupP95Ms60m: 0,
  lastSendAt: '2026-10-06T15:29:00.000Z',
  ...over,
});
/** /health/detailed's hostClock block as the scraper serves it: another store's host first, then mfc's. */
const STUB_BLOCK = { mode: 'on', hosts: [hostView('other.test', { minGapMs60m: 1 }), hostView('mfc.test')] };
const MFC_CLOCK = {
  host: 'mfc.test',
  floorMs: 7000,
  clocked: true,
  minGapMs60m: 7012,
  underFloor60m: 1,
  sends60m: sends({ queue: 4, catalogListing: 2, catalogRotating: 2 }),
  catalogListing: 2,
  listingFetchP99Ms60m: 1800,
};

const mfcLedger = (): Ledger => {
  const l: Ledger = { ...createEmptyLedger('mfc'), range: { cursor: 500, frontier: 1000 } };
  for (const id of [1002, 2042]) l.enqueued[String(id)] = { at: iso(DAY0 - HOUR_MS), collectUrl: itemUrl('mfc', id) };
  return l;
};

/** hh:30Z on day 0 (DAY0 is 00:30Z). */
const at = (hh: number): number => DAY0 + hh * HOUR_MS;

interface Run {
  summaries: CrawlerStoreSummary[][];
  records: PassStrategyRecord[];
  lines: string[];
  calls: Call[];
  reads: number;
}

/**
 * Passes at the given UTC hours of day 0 against one fake engine: a list GET moves the clock 1 s, a listing
 * GET 0.5 s, and the lists spacing sleeps on the same clock. Every info line is captured.
 */
const runPasses = async (
  hours: number[],
  cfg: CrawlerConfig,
  o: { reply?: (c: Call) => Reply | undefined; readHostClock?: () => Promise<unknown>; ring?: PassRingStore; ledgers?: Record<string, Ledger> } = {},
): Promise<Run> => {
  const c = clock();
  const engine = makeEngine(c.now, {
    decl: () => ({ status: 200, body: { siteId: 'mfc', rotatingSeedLists: DECL3, count: DECL3.length } }),
    list: (id) => {
      c.advance(1000);
      return LISTS[id] ?? { status: 404, body: {} };
    },
    onListing: () => c.advance(500),
    reply: o.reply,
  });
  const ledgerStore = createMemoryLedgerStore(o.ledgers ?? { mfc: mfcLedger() });
  const listsStore = createMemoryListsStateStore();
  const records: PassStrategyRecord[] = [];
  const ring: PassRingStore = o.ring ?? { append: async (_siteId, rec) => void records.push(rec) };
  let reads = 0;
  const readHostClock = o.readHostClock ?? (async () => STUB_BLOCK);
  const lines: string[] = [];
  jest.spyOn(logger, 'info').mockImplementation((message: string, data?: unknown) => {
    lines.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`);
  });
  const summaries: CrawlerStoreSummary[][] = [];
  for (const h of hours) {
    c.set(at(h));
    const summary = await runCrawlerPass(cfg, {
      fetch: engine.fetch,
      ledgerStore,
      listsStore,
      now: c.now,
      sleep: c.sleep,
      readHostClock: async () => {
        reads++;
        return readHostClock();
      },
      passRing: ring,
    });
    summaries.push(summary.stores);
  }
  return { summaries, records, lines, calls: engine.calls, reads };
};

const mfcOnly = (over: Partial<CrawlerConfig> = {}): CrawlerConfig =>
  simConfig({
    stores: ['mfc'],
    rangeStores: ['mfc'],
    storeEnqueueCaps: { mfc: 10 },
    listsDrainCaps: { mfc: 5 },
    listsAlternate: ['mfc'],
    listsAlternateRatios: { mfc: { lists: 2, tap: 1 } },
    ...over,
  });

const strategyLines = (lines: string[]): string[] => lines.filter((l) => l.startsWith('[CRAWLER] pass-strategy'));
const parseLine = (l: string): unknown => JSON.parse(l.slice('[CRAWLER] pass-strategy '.length));
const mfcOf = (stores: CrawlerStoreSummary[]): CrawlerStoreSummary => stores.find((s) => s.siteId === 'mfc') as CrawlerStoreSummary;

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('pass-strategy record — mfc:2:1 over L, L, T', () => {
  let run: Run;
  beforeAll(async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Pass 3 (the tap) meets a cooldown on its backfill page.
    run = await runPasses([15, 16, 17], mfcOnly(), { reply: (c) => (c.store === 'mfc' && c.kind === 'listing' && c.page !== 1 ? COOLDOWN : undefined) });
    jest.restoreAllMocks();
  });

  it('pass 1 (lists, step 1): one company, both domains, per-list ids, dup = seen - new, the step and pass durations', () => {
    expect(run.records[0]).toEqual({
      strategyVersion: 1,
      siteId: 'mfc',
      at: iso(at(15)),
      strategy: 'lists',
      strategyParams: { ratio: '2:1', step: 1 },
      listsCompanies: [{ entryId: '7620' }],
      listsDomains: [9, 1],
      listsPerList: [
        { listId: 'company-7620-d9', domainId: 9, status: 'ok', ids: 3 },
        { listId: 'company-7620-d1', domainId: 1, status: 'ok', ids: 2 },
      ],
      idsDiscovered: 4,
      idsNew: 3,
      idsDup: 1,
      challenges: 0,
      cooldowns: 0,
      // Two list GETs (1 s each) and the 10 s spacing between them.
      listsStepMs: 12_000,
      storePassMs: 12_000,
      hostClock: MFC_CLOCK,
    });
  });

  it('pass 2 (lists, step 2): a challenge page fails the first list and the second is skipped', () => {
    expect(run.records[1]).toMatchObject({
      strategy: 'lists',
      strategyParams: { ratio: '2:1', step: 2 },
      listsCompanies: [{ entryId: '7721' }],
      listsDomains: [9, 1],
      listsPerList: [
        { listId: 'company-7721-d9', domainId: 9, status: 'failed', ids: 0 },
        { listId: 'company-7721-d1', domainId: 1, status: 'skipped', ids: 0 },
      ],
      idsDiscovered: 0,
      idsNew: 0,
      idsDup: 0,
      challenges: 1,
      cooldowns: 0,
      listsStepMs: 1000,
      storePassMs: 1000,
    });
  });

  it('pass 3 (tap, step 3): the tap\'s ids, a cooldown on the backfill page, no list, no lists step', () => {
    expect(run.records[2]).toEqual({
      strategyVersion: 1,
      siteId: 'mfc',
      at: iso(at(17)),
      strategy: 'tap',
      strategyParams: { ratio: '2:1', step: 3 },
      listsCompanies: [],
      listsDomains: [],
      listsPerList: [],
      // Page 1 at 17:30 holds 2044-2041; 2042 is in the ledger.
      idsDiscovered: 4,
      idsNew: 3,
      idsDup: 1,
      challenges: 0,
      cooldowns: 1,
      listsStepMs: 0,
      storePassMs: 1000,
      hostClock: MFC_CLOCK,
    });
  });

  it('every pass logs exactly ONE single-line pass-strategy record, the same record the ring got', () => {
    const lines = strategyLines(run.lines);
    expect(lines).toHaveLength(3);
    for (const [i, l] of lines.entries()) {
      expect(l).not.toContain('\n');
      expect(parseLine(l)).toEqual(run.records[i]);
    }
    expect(PASS_STRATEGY_VERSION).toBe(1);
  });

  it('the store summary carries the same fields (and no version or pass stamp)', () => {
    for (const [i, stores] of run.summaries.entries()) {
      const { strategyVersion: _v, siteId: _s, at: _a, ...fields } = run.records[i];
      expect(mfcOf(stores)).toMatchObject(fields);
      expect(mfcOf(stores)).not.toHaveProperty('strategyVersion');
    }
  });

  it('reads the hostClock block once per pass', () => {
    expect(run.reads).toBe(3);
  });

  it('never asks for /health/detailed through the crawl\'s own fetch: the read is the injected reader', () => {
    expect(run.calls.filter((c) => c.line.includes('/health'))).toEqual([]);
  });
});

describe('pass-strategy record — other pass kinds', () => {
  it('a pass outside the window: strategy outside-window, no ratio or step, the tap\'s ids', async () => {
    const run = await runPasses([3], mfcOnly());
    expect(run.records[0]).toMatchObject({
      strategy: 'outside-window',
      strategyParams: { ratio: null, step: null },
      listsCompanies: [],
      listsDomains: [],
      listsPerList: [],
      idsDiscovered: 8,
      challenges: 0,
      cooldowns: 0,
    });
    // Two listing pages (recent + backfill) of four ids each at 03:30: none known.
    expect(run.records[0].idsNew).toBe(8);
    expect(run.records[0].idsDup).toBe(0);
    expect(run.records[0].storePassMs).toBe(1000);
  });

  it('fallback-tap: the declaration offers nothing due, so the pass taps and counts the tap', async () => {
    const c = clock();
    const engine = makeEngine(c.now, { decl: () => ({ status: 200, body: { siteId: 'mfc', rotatingSeedLists: [], count: 0 } }) });
    const records: PassStrategyRecord[] = [];
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    c.set(at(15));
    await runCrawlerPass(mfcOnly(), {
      fetch: engine.fetch,
      ledgerStore: createMemoryLedgerStore({ mfc: mfcLedger() }),
      listsStore: createMemoryListsStateStore(),
      now: c.now,
      sleep: c.sleep,
      readHostClock: async () => STUB_BLOCK,
      passRing: { append: async (_s, r) => void records.push(r) },
    });
    expect(records[0]).toMatchObject({ strategy: 'fallback-tap', strategyParams: { ratio: '2:1', step: 1 }, listsCompanies: [], listsPerList: [] });
    expect(records[0].idsDiscovered).toBe(8);
  });

  it('a challenge page on the tap counts a challenge; a 503 without the cooldown envelope counts nothing', async () => {
    const run = await runPasses([3], mfcOnly(), {
      reply: (c) => (c.store === 'mfc' && c.kind === 'listing' ? (c.page === 1 ? CHALLENGE_PAGE : { status: 503, body: {} }) : undefined),
    });
    expect(run.records[0]).toMatchObject({ challenges: 1, cooldowns: 0, idsDiscovered: 0 });
  });

  it('a 502 on the tap that is not a challenge (or has no JSON body) counts nothing', async () => {
    const run = await runPasses([3], mfcOnly(), {
      reply: (c) => (c.store === 'mfc' && c.kind === 'listing' ? { status: 502, body: { error: 'catalog failed', reason: 'timeout' } } : undefined),
    });
    expect(run.records[0]).toMatchObject({ challenges: 0, cooldowns: 0 });
  });

  it('a cooldown on a company list counts a cooldown and leaves the list skipped', async () => {
    const saved = LISTS['company-7620-d9'];
    LISTS['company-7620-d9'] = COOLDOWN;
    try {
      const run = await runPasses([15], mfcOnly());
      expect(run.records[0]).toMatchObject({
        challenges: 0,
        cooldowns: 1,
        listsCompanies: [{ entryId: '7620' }],
        listsPerList: [
          { listId: 'company-7620-d9', domainId: 9, status: 'skipped', ids: 0 },
          { listId: 'company-7620-d1', domainId: 1, status: 'skipped', ids: 0 },
        ],
      });
    } finally {
      LISTS['company-7620-d9'] = saved;
    }
  });

  it('a list id without a -d<n> suffix reports domainId null and adds no domain', async () => {
    const c = clock();
    const decl = [{ id: 'gsc-top', url: 'https://mfc.test/top', group: 'top', order: 1 }];
    const engine = makeEngine(c.now, {
      decl: () => ({ status: 200, body: { siteId: 'mfc', rotatingSeedLists: decl, count: 1 } }),
      list: () => ok(items([1500, 1002])),
    });
    const records: PassStrategyRecord[] = [];
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    c.set(at(15));
    await runCrawlerPass(mfcOnly(), {
      fetch: engine.fetch,
      ledgerStore: createMemoryLedgerStore({ mfc: mfcLedger() }),
      listsStore: createMemoryListsStateStore(),
      now: c.now,
      sleep: c.sleep,
      readHostClock: async () => STUB_BLOCK,
      passRing: { append: async (_s, r) => void records.push(r) },
    });
    expect(records[0]).toMatchObject({
      listsCompanies: [{ entryId: 'top' }],
      listsDomains: [],
      listsPerList: [{ listId: 'gsc-top', domainId: null, status: 'ok', ids: 2 }],
      idsDiscovered: 2,
      idsNew: 1,
      idsDup: 1,
    });
  });
});

describe('pass-strategy record — the hostClock read', () => {
  it('a failed read logs a WARN and records hostClock null; the pass and its record go on', async () => {
    const run = await runPasses([15], mfcOnly(), { readHostClock: async () => Promise.reject(new Error('connect ECONNREFUSED')) });
    expect(run.records).toHaveLength(1);
    expect(run.records[0].hostClock).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hostClock'), expect.objectContaining({ error: 'connect ECONNREFUSED' }));
  });

  it.each([
    ['no block', undefined],
    ['a block without hosts', { mode: 'on' }],
    ['hosts that are not a list', { mode: 'on', hosts: 'mfc.test' }],
    ['no entry for the store\'s host', { mode: 'on', hosts: [hostView('other.test')] }],
    ['a malformed entry for the host', { mode: 'on', hosts: [null, hostView('mfc.test', { minGapMs60m: 'soon' })] }],
    ['sends that are not a map', { mode: 'on', hosts: [hostView('mfc.test', { sends60m: [1, 2] })] }],
    ['a non-numeric send count', { mode: 'on', hosts: [hostView('mfc.test', { sends60m: sends({ queue: Number.NaN }) })] }],
  ])('%s: hostClock null', async (_label, block) => {
    const run = await runPasses([15], mfcOnly(), { readHostClock: async () => block });
    expect(run.records[0].hostClock).toBeNull();
  });

  it('matches the store\'s host case- and www-insensitively', async () => {
    const run = await runPasses([15], mfcOnly(), { readHostClock: async () => ({ mode: 'on', hosts: [hostView('WWW.MFC.test')] }) });
    expect(run.records[0].hostClock).toEqual({ ...MFC_CLOCK, host: 'WWW.MFC.test' });
  });

  it('a store whose ledger holds no usable url has no host: hostClock null', async () => {
    const l = mfcLedger();
    l.enqueued = { x: { at: iso(DAY0), collectUrl: 'not a url' } };
    const run = await runPasses([15], mfcOnly(), { ledgers: { mfc: l } });
    expect(run.records[0].hostClock).toBeNull();
  });

  it('a store whose ledger was refused records strategy off and hostClock null', async () => {
    const c = clock();
    const engine = makeEngine(c.now);
    const records: PassStrategyRecord[] = [];
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    c.set(at(15));
    await runCrawlerPass(mfcOnly(), {
      fetch: engine.fetch,
      ledgerStore: { load: async () => 'corrupt', save: async () => undefined },
      listsStore: createMemoryListsStateStore(),
      now: c.now,
      sleep: c.sleep,
      readHostClock: async () => STUB_BLOCK,
      passRing: { append: async (_s, r) => void records.push(r) },
    });
    expect(records[0]).toMatchObject({ strategy: 'off', strategyParams: { ratio: null, step: null }, hostClock: null, idsDiscovered: 0, storePassMs: 0 });
  });

  it('two alternated stores share ONE read per pass and each gets its own record', async () => {
    const hpoi: Ledger = { ...createEmptyLedger('hpoi'), range: { cursor: 800, frontier: 900 } };
    hpoi.enqueued['2'] = { at: iso(DAY0), collectUrl: itemUrl('hpoi', 2) };
    const run = await runPasses([3], mfcOnly({ stores: ['mfc', 'hpoi'], rangeStores: ['mfc', 'hpoi'], listsDrainCaps: { mfc: 5, hpoi: 5 }, listsAlternate: ['mfc', 'hpoi'] }), {
      ledgers: { mfc: mfcLedger(), hpoi },
      readHostClock: async () => ({ mode: 'on', hosts: [hostView('mfc.test'), hostView('hpoi.test', { floorMs: 3000 })] }),
    });
    expect(run.reads).toBe(1);
    expect(run.records.map((r) => [r.siteId, r.hostClock?.host, r.hostClock?.floorMs])).toEqual([
      ['mfc', 'mfc.test', 7000],
      ['hpoi', 'hpoi.test', 3000],
    ]);
  });

  it('without a reader the record still lands, hostClock null', async () => {
    const c = clock();
    const engine = makeEngine(c.now);
    const records: PassStrategyRecord[] = [];
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    c.set(at(3));
    await runCrawlerPass(mfcOnly(), {
      fetch: engine.fetch,
      ledgerStore: createMemoryLedgerStore({ mfc: mfcLedger() }),
      listsStore: createMemoryListsStateStore(),
      now: c.now,
      sleep: c.sleep,
      passRing: { append: async (_s, r) => void records.push(r) },
    });
    expect(records[0].hostClock).toBeNull();
  });
});

describe('pass-strategy record — the ring', () => {
  it('a ring that refuses the append logs a WARN; the pass returns its summary and the line is still logged', async () => {
    const run = await runPasses([15], mfcOnly(), { ring: { append: async () => Promise.reject(new Error('EACCES: permission denied')) } });
    expect(mfcOf(run.summaries[0]).strategy).toBe('lists');
    expect(strategyLines(run.lines)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ring'), expect.objectContaining({ siteId: 'mfc', error: 'EACCES: permission denied' }));
  });

  it('a ring that throws synchronously is contained the same way', async () => {
    const run = await runPasses([15], mfcOnly(), {
      ring: {
        append: () => {
          throw new Error('boom');
        },
      },
    });
    expect(strategyLines(run.lines)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ring'), expect.objectContaining({ error: 'boom' }));
  });

  it('a ring that dropped damaged lines says so in a WARN', async () => {
    await runPasses([15], mfcOnly(), { ring: { append: async () => ({ kept: 3, droppedAged: 0, droppedOversize: 0, droppedMalformed: 2 }) } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.objectContaining({ siteId: 'mfc', droppedMalformed: 2 }));
  });

  it('a clean append logs no WARN', async () => {
    await runPasses([15], mfcOnly(), { ring: { append: async () => ({ kept: 3, droppedAged: 1, droppedOversize: 1, droppedMalformed: 0 }) } });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('ring'), expect.anything());
  });

  it('without a ring the line is still logged', async () => {
    const c = clock();
    const engine = makeEngine(c.now);
    const lines: string[] = [];
    jest.spyOn(logger, 'info').mockImplementation((m: string) => void lines.push(m));
    c.set(at(3));
    await runCrawlerPass(mfcOnly(), { fetch: engine.fetch, ledgerStore: createMemoryLedgerStore({ mfc: mfcLedger() }), listsStore: createMemoryListsStateStore(), now: c.now, sleep: c.sleep });
    expect(strategyLines(lines)).toHaveLength(1);
  });
});

describe('pass-strategy record — stores not alternated', () => {
  it('no record, no line, no read, no ring append, and none of the fields on any summary', async () => {
    const appended: unknown[] = [];
    const run = await runPasses([15, 16, 17, 3], simConfig({ storeEnqueueCaps: { mfc: 10 }, listsDrainCaps: { mfc: 5 } }), {
      ledgers: { mfc: mfcLedger() },
      ring: { append: async (_s, r) => void appended.push(r) },
    });
    expect(appended).toEqual([]);
    expect(strategyLines(run.lines)).toEqual([]);
    expect(run.reads).toBe(0);
    const added = ['strategy', 'strategyParams', 'listsCompanies', 'listsDomains', 'listsPerList', 'idsDiscovered', 'idsNew', 'idsDup', 'challenges', 'cooldowns', 'listsStepMs', 'storePassMs', 'hostClock'];
    for (const stores of run.summaries) for (const s of stores) for (const k of added) expect(s).not.toHaveProperty(k);
  });

  it('in an alternated pass only the alternated store carries the fields', async () => {
    const run = await runPasses([15], simConfig({ storeEnqueueCaps: { mfc: 10 }, listsDrainCaps: { mfc: 5 }, listsAlternate: ['mfc'] }));
    for (const s of run.summaries[0]) {
      if (s.siteId === 'mfc') expect(s).toHaveProperty('strategy', 'lists');
      else expect(s).not.toHaveProperty('strategy');
    }
    expect(run.records.map((r) => r.siteId)).toEqual(['mfc']);
  });

  it('seed mode is untouched: no record even with the knob set', async () => {
    const run = await runPasses([15], mfcOnly({ mode: 'seed', phases: ['seed'] }));
    expect(run.records).toEqual([]);
    expect(run.reads).toBe(0);
  });
});
