/**
 * QB-U24 acceptance (knob off): with CRAWLER_PAGE_POOL unset, empty or `off`, a fourteen-pass crawl of a
 * paged listing store, a store resuming a saved cursor and mfc's single-page feed is byte-identical to
 * develop: the same GETs and POSTs in the same order, the same store summaries and the same ledgers after
 * every pass. The scenario walks a fresh cursor, a cap cutting a page short, listing drift between passes,
 * a cooldown, an exhaustion candidate and its confirmation, a re-check that is not due and one that is.
 *
 * The fixture was written by this same file on develop 049ac7ce (before QB-U24); PAGE_POOL_GOLDEN_OUT=<file>
 * writes the trace a tree produces, to regenerate it there. The file never names a pool field, so it runs
 * unchanged on both trees. Fake engine and fake clock: no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { runCrawlerPass } from '../../crawler/crawler';
import { loadCrawlerConfig } from '../../crawler/config';
import { createEmptyLedger, createMemoryLedgerStore } from '../../crawler/ledger';
import { createMemoryListsStateStore } from '../../crawler/listsState';
import { fakeClock, idRun, itemUrl, makePagedEngine } from '../helpers/pagedCatalogEngine';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'crawler', 'pagePoolOffGolden.json');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = Date.parse('2026-10-07T01:30:00.000Z');

const ENV: Record<string, string> = {
  SCRAPER_SERVICE_URL: 'http://scraper.test',
  CRAWLER_STORES: 'orzgk,hlj,mfc',
  CRAWLER_MODE: 'both',
  CRAWLER_LEDGER_DIR: '/unused',
  CRAWLER_RECENT_MAX_PAGES: '3',
  CRAWLER_BACKFILL_PAGES_PER_RUN: '5',
  CRAWLER_MAX_REQUESTS: '400',
  CRAWLER_MAX_ENQUEUE_PER_STORE: '45',
  CRAWLER_MAX_CONCURRENCY: '2',
  CRAWLER_REQUEST_SPACING_MS: '1000',
  CRAWLER_REOBSERVE_AFTER_MS: '0',
};

const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

const trace = async (env: Record<string, string>) => {
  const engine = makePagedEngine(
    {
      orzgk: { pageSize: 10, items: idRun('o', 1226, 226) },
      hlj: { pageSize: 8, items: idRun('h', 2120, 120) },
      mfc: { pageSize: 50, items: idRun('m', 3005, 5), singlePage: true },
    },
    { reply: (store, page) => (cooling && store === 'hlj' && page >= 13 ? { status: 503, body: { error: 'cooldown', siteId: 'hlj', host: 'hlj.test', remainingMs: 60_000 } } : undefined) },
  );
  let cooling = false;
  // hlj resumes a cursor an earlier pass saved: pages 1..6 were walked and their ids are known.
  const hlj = createEmptyLedger('hlj');
  for (const id of idRun('h', 2120, 48)) hlj.enqueued[id] = { at: new Date(T0 - DAY_MS).toISOString(), collectUrl: itemUrl('hlj', id) };
  hlj.backfill = { cursor: 7, updatedAt: new Date(T0 - DAY_MS).toISOString() };
  const ledgers = createMemoryLedgerStore({ hlj });
  const lists = createMemoryListsStateStore();
  const clock = fakeClock(T0);
  const cfg = loadCrawlerConfig({ ...ENV, ...env }, []);
  const passes: unknown[] = [];
  for (let i = 0; i < 14; i++) {
    // Thirteen hourly passes, then one eight days later: the mfc and orzgk end re-checks are due.
    clock.set(i < 13 ? T0 + i * HOUR_MS : T0 + 12 * HOUR_MS + 8 * DAY_MS);
    if (i === 2 || i === 5 || i === 8) {
      engine.prepend('orzgk', idRun('n', 9000 + i * 10, 3));
      engine.prepend('hlj', idRun('k', 9500 + i * 10, 2));
    }
    cooling = i === 1;
    const mark = engine.calls.length;
    const summary = await runCrawlerPass(cfg, { fetch: engine.fetch, ledgerStore: ledgers, listsStore: lists, now: clock.now, sleep: clock.sleep });
    passes.push({
      pass: i,
      calls: engine.calls.slice(mark).map((c) => c.line),
      stores: summary.stores,
      ledgers: digest([...ledgers.files.entries()].sort(([a], [b]) => a.localeCompare(b))),
    });
  }
  return { passes, finalLedgers: Object.fromEntries([...ledgers.files.entries()].sort(([a], [b]) => a.localeCompare(b))) };
};

describe('CRAWLER_PAGE_POOL off: the crawl is byte-identical to develop', () => {
  if (process.env.PAGE_POOL_GOLDEN_OUT) {
    it('writes the golden', async () => {
      fs.writeFileSync(process.env.PAGE_POOL_GOLDEN_OUT as string, `${JSON.stringify(await trace({}), null, 2)}\n`);
    });
    return;
  }
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  it.each([
    ['unset', {}],
    ['empty', { CRAWLER_PAGE_POOL: '' }],
    ['off', { CRAWLER_PAGE_POOL: 'off' }],
    ['OFF, padded', { CRAWLER_PAGE_POOL: ' OFF ' }],
    ['a store not crawled', { CRAWLER_PAGE_POOL: 'amiami' }],
  ])('%s: the same requests, summaries and ledgers', async (_label, env) => {
    expect(await trace(env)).toEqual(golden);
  });

  it('the scenario exercises what it claims (cursor walk, cap, cooldown, exhaustion, both re-checks)', () => {
    const lines = golden.passes.flatMap((p: { calls: string[] }) => p.calls);
    expect(lines.filter((l: string) => l.startsWith('GET')).length).toBeGreaterThan(40);
    const last = golden.passes[13].stores;
    const byId = Object.fromEntries(last.map((s: { siteId: string }) => [s.siteId, s]));
    expect(byId.mfc.exhausted).toBe(true);
    expect(byId.orzgk.exhausted).toBe(true);
    expect(golden.passes.some((p: { stores: Array<{ skipped: number }> }) => p.stores.some((s) => s.skipped > 0))).toBe(true);
    expect(golden.passes.some((p: { stores: Array<{ exhaustCandidate: boolean }> }) => p.stores.some((s) => s.exhaustCandidate))).toBe(true);
  });
});
