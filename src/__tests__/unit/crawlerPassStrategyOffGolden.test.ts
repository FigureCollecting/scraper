/**
 * QB-U36 acceptance (knob off): with no store in CRAWLER_LISTS_ALTERNATE (unset, or naming only stores that
 * cannot alternate) a day of hourly passes is byte-identical to develop: the same requests in the same order,
 * the same store summaries and the same INFO lines (message and data), even with the hostClock reader and the
 * ring wired. The scenario covers the lists window, company lists, a challenge page on a list and on a
 * listing, and a cooldown on a listing, so every new counting point is crossed with the knob off.
 *
 * The fixture was written by this same file on develop e914fe6c (before QB-U36); PASS_STRATEGY_GOLDEN_OUT=<file>
 * writes the trace a tree produces. Fake engine and fake clock: no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { runCrawlerPass, type CrawlerConfig } from '../../crawler/crawler';
import { createMemoryLedgerStore } from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import { logger } from '../../utils/logger';
import { DAY0, HOUR_MS, backlogState, clock, listOk, makeEngine, seedLedgers, simConfig, type Call, type Reply } from '../helpers/crawlerAlternationSim';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'crawler', 'passStrategyOffGolden.json');

const CHALLENGE_LIST: Reply = { status: 502, body: { error: 'catalog failed', siteId: 'mfc', failure: 'deterministic', blocked: true, reason: 'challenge page', upstreamStatus: 403 } };
const CHALLENGE_PAGE: Reply = { status: 502, body: { error: 'catalog failed', reason: 'challenge page' } };
const COOLDOWN: Reply = { status: 503, body: { error: 'cooldown', host: 'x.test', remainingMs: 60_000 } };

/** Each INFO line's message in full, and a digest of every line (message and data) of the pass. */
const infoTrace = (lines: Array<[string, string]>) => ({
  messages: lines.map(([m]) => m),
  digest: createHash('sha256').update(JSON.stringify(lines)).digest('hex'),
});

const trace = async (over: Partial<CrawlerConfig>) => {
  const c = clock();
  const engine = makeEngine(c.now, {
    list: (id) => (id === 'c3-d9' ? CHALLENGE_LIST : listOk(id)),
    onListing: () => c.advance(500),
    reply: (call: Call) => {
      const hour = Math.floor((c.now() - DAY0) / HOUR_MS);
      if (call.kind === 'listing' && call.store === 'hpoi' && hour === 2) return CHALLENGE_PAGE;
      if (call.kind === 'listing' && call.store === 'orzgk' && hour === 4 && call.page !== 1) return COOLDOWN;
      if (call.kind === 'listing' && call.store === 'mfc' && hour === 16) return CHALLENGE_PAGE;
      if (call.kind === 'listing' && call.store === 'mfc' && hour === 18) return COOLDOWN;
      return undefined;
    },
  });
  const ledgers = createMemoryLedgerStore(seedLedgers());
  const lists = createMemoryListsStateStore({ mfc: backlogState(20) });
  const info: Array<[string, string]> = [];
  const spy = jest.spyOn(logger, 'info').mockImplementation((message: string, data?: unknown) => {
    info.push([message, data === undefined ? '' : JSON.stringify(data)]);
  });
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const cfg = simConfig({ storeEnqueueCaps: { mfc: 10 }, listsDrainCaps: { mfc: 3 }, ...over });
  const passes: unknown[] = [];
  let reads = 0;
  let appends = 0;
  try {
    for (let i = 0; i < 24; i++) {
      c.set(DAY0 + i * HOUR_MS);
      const mark = engine.calls.length;
      const infoMark = info.length;
      const summary = await runCrawlerPass(cfg, {
        fetch: engine.fetch,
        ledgerStore: ledgers,
        listsStore: lists,
        now: c.now,
        sleep: c.sleep,
        // Ignored by a tree without QB-U36; never called by one with it while no store alternates.
        ...({
          readHostClock: async () => {
            reads++;
            return { mode: 'on', hosts: [] };
          },
          passRing: {
            append: async () => {
              appends++;
            },
          },
        } as object),
      });
      passes.push({ pass: i, calls: engine.calls.slice(mark).map((x) => x.line), stores: summary.stores, info: infoTrace(info.slice(infoMark)) });
    }
  } finally {
    spy.mockRestore();
    warn.mockRestore();
  }
  return { trace: { passes, finalLists: lists.files.get('mfc') }, reads, appends };
};

describe('CRAWLER_LISTS_ALTERNATE off: the crawl and its log are byte-identical to develop', () => {
  if (process.env.PASS_STRATEGY_GOLDEN_OUT) {
    it('writes the golden', async () => {
      fs.writeFileSync(process.env.PASS_STRATEGY_GOLDEN_OUT as string, `${JSON.stringify((await trace({})).trace, null, 2)}\n`);
    });
    return;
  }
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  it.each([
    ['unset', {}],
    ['empty', { listsAlternate: [] }],
    ['a store not crawled', { listsAlternate: ['amiami'] }],
    ['a store with no lists step', { listsAlternate: ['orzgk', 'hpoi'] }],
  ])('%s: the same requests, summaries and INFO lines; no hostClock read, no ring append', async (_label, over) => {
    const got = await trace(over as Partial<CrawlerConfig>);
    expect(got.trace).toEqual(golden);
    expect(JSON.stringify(got.trace)).not.toContain('pass-strategy');
    expect(got.reads).toBe(0);
    expect(got.appends).toBe(0);
  });

  it('the scenario crosses what it claims (lists in the window, challenges on a list and a listing, a cooldown)', () => {
    const all = golden.passes.flatMap((p: { calls: string[] }) => p.calls);
    expect(all.some((l: string) => l.includes('/catalog/rotating?store=mfc&list=c3-d9'))).toBe(true);
    const stores = golden.passes.flatMap((p: { stores: Array<{ siteId: string; skipped: number; errors: number; listsGroup: string | null }> }) => p.stores);
    expect(stores.some((s: { skipped: number }) => s.skipped > 0)).toBe(true);
    expect(stores.filter((s: { siteId: string; errors: number }) => s.siteId === 'hpoi' && s.errors > 0).length).toBeGreaterThan(0);
    expect(stores.filter((s: { listsGroup: string | null }) => s.listsGroup !== null).length).toBeGreaterThan(2);
  });
});
