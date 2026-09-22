/**
 * loadCrawlerConfig — env → CrawlerConfig with safe defaults. The catalog crawler is
 * a bounded, CronJob-driven pass (recent THEN backfill); every knob is env with a
 * conservative default so an unconfigured run is safe on the single egress IP.
 */
import { loadCrawlerConfig, DEFAULT_CRAWLER_STORES } from '../../crawler/config';
import { logger } from '../../utils/logger';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe('loadCrawlerConfig', () => {
  it('applies safe defaults when env is empty', () => {
    const c = loadCrawlerConfig({});
    expect(c.scraperServiceUrl).toBe('http://localhost:3050');
    expect(c.mode).toBe('both');
    expect(c.stores).toEqual(['orzgk']);
    expect(DEFAULT_CRAWLER_STORES).toEqual(['orzgk']);
    expect(c.ledgerDir).toBe('/var/lib/ingest-crawler');
    expect(c.recentMaxPages).toBe(3);
    expect(c.backfillPagesPerRun).toBe(5);
    expect(c.maxRequests).toBe(100);
    expect(c.maxEnqueuePerStore).toBe(50);
    expect(c.maxConcurrency).toBe(2);
    expect(c.requestSpacingMs).toBe(1000);
    expect(c.requestTimeoutMs).toBe(45000);
    expect(c.reobserveAfterMs).toBe(WEEK_MS);
    expect(c.exhaustedRecheckMs).toBe(WEEK_MS);
  });

  it('CRAWLER_SEED_SPACING_MS defaults to 10s, honours an explicit 0, and ignores junk', () => {
    expect(loadCrawlerConfig({}).seedSpacingMs).toBe(10000);
    expect(loadCrawlerConfig({ CRAWLER_SEED_SPACING_MS: '30000' }).seedSpacingMs).toBe(30000);
    expect(loadCrawlerConfig({ CRAWLER_SEED_SPACING_MS: '0' }).seedSpacingMs).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_SEED_SPACING_MS: 'abc' }).seedSpacingMs).toBe(10000);
    expect(loadCrawlerConfig({ CRAWLER_SEED_SPACING_MS: '-5' }).seedSpacingMs).toBe(10000);
  });

  it('accepts recent / backfill / seed modes; an ABSENT or empty value is both, an unknown one is fatal', () => {
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'recent' }).mode).toBe('recent');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'backfill' }).mode).toBe('backfill');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'seed' }).mode).toBe('seed');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'both' }).mode).toBe('both');
    expect(loadCrawlerConfig({ CRAWLER_MODE: '' }).mode).toBe('both');
    expect(() => loadCrawlerConfig({ CRAWLER_MODE: 'whatever' })).toThrow(/whatever/);
  });

  it('parses csv stores, trimming blanks and whitespace', () => {
    const c = loadCrawlerConfig({ CRAWLER_STORES: ' orzgk , , goodsmileus ' });
    expect(c.stores).toEqual(['orzgk', 'goodsmileus']);
  });

  it('honors an explicitly-set empty CRAWLER_STORES as zero stores (operator kill switch)', () => {
    expect(loadCrawlerConfig({ CRAWLER_STORES: '' }).stores).toEqual([]);
    expect(loadCrawlerConfig({ CRAWLER_STORES: '  ' }).stores).toEqual([]);
  });

  it('uses the default store set only when CRAWLER_STORES is unset', () => {
    expect(loadCrawlerConfig({}).stores).toEqual(['orzgk']);
  });

  it('parses every numeric knob', () => {
    const c = loadCrawlerConfig({
      CRAWLER_RECENT_MAX_PAGES: '2',
      CRAWLER_BACKFILL_PAGES_PER_RUN: '9',
      CRAWLER_MAX_REQUESTS: '25',
      CRAWLER_MAX_ENQUEUE_PER_STORE: '7',
      CRAWLER_MAX_CONCURRENCY: '4',
      CRAWLER_REQUEST_SPACING_MS: '750',
      CRAWLER_REQUEST_TIMEOUT_MS: '9000',
      CRAWLER_REOBSERVE_AFTER_MS: '3600000',
      CRAWLER_EXHAUSTED_RECHECK_MS: '86400000',
    });
    expect(c.recentMaxPages).toBe(2);
    expect(c.backfillPagesPerRun).toBe(9);
    expect(c.maxRequests).toBe(25);
    expect(c.maxEnqueuePerStore).toBe(7);
    expect(c.maxConcurrency).toBe(4);
    expect(c.requestSpacingMs).toBe(750);
    expect(c.requestTimeoutMs).toBe(9000);
    expect(c.reobserveAfterMs).toBe(3600000);
    expect(c.exhaustedRecheckMs).toBe(86400000);
  });

  it('falls back to defaults on non-numeric or negative knobs (positive knobs floored at 1)', () => {
    const c = loadCrawlerConfig({
      CRAWLER_RECENT_MAX_PAGES: 'abc',
      CRAWLER_BACKFILL_PAGES_PER_RUN: '-3',
      CRAWLER_MAX_REQUESTS: '-1',
      CRAWLER_MAX_ENQUEUE_PER_STORE: 'x',
      CRAWLER_MAX_CONCURRENCY: '0',
      CRAWLER_REQUEST_SPACING_MS: '0',
      CRAWLER_REQUEST_TIMEOUT_MS: 'nope',
      CRAWLER_REOBSERVE_AFTER_MS: '-5',
      CRAWLER_EXHAUSTED_RECHECK_MS: '0',
    });
    expect(c.recentMaxPages).toBe(3);
    expect(c.backfillPagesPerRun).toBe(5);
    expect(c.maxRequests).toBe(100);
    expect(c.maxEnqueuePerStore).toBe(50);
    expect(c.maxConcurrency).toBe(2);
    expect(c.requestSpacingMs).toBe(1000);
    expect(c.requestTimeoutMs).toBe(45000);
    expect(c.reobserveAfterMs).toBe(WEEK_MS);
    expect(c.exhaustedRecheckMs).toBe(WEEK_MS);
  });

  it('honors an explicit zero for the budget knobs as a hard clamp (kill switch / dry run)', () => {
    // CRAWLER_MAX_REQUESTS=0 → the gate dispatches nothing (kill switch);
    // CRAWLER_MAX_ENQUEUE_PER_STORE=0 → discovery-only dry run (fetch pages, POST nothing).
    const c = loadCrawlerConfig({ CRAWLER_MAX_REQUESTS: '0', CRAWLER_MAX_ENQUEUE_PER_STORE: '0' });
    expect(c.maxRequests).toBe(0);
    expect(c.maxEnqueuePerStore).toBe(0);
  });

  it('honors CRAWLER_REOBSERVE_AFTER_MS=0 as "never re-observe"', () => {
    expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_AFTER_MS: '0' }).reobserveAfterMs).toBe(0);
  });

  it('trims a trailing slash from SCRAPER_SERVICE_URL', () => {
    expect(loadCrawlerConfig({ SCRAPER_SERVICE_URL: 'http://scraper:3050/' }).scraperServiceUrl).toBe('http://scraper:3050');
  });

  it('reads process.env when no env is passed', () => {
    const saved = process.env.CRAWLER_MODE;
    process.env.CRAWLER_MODE = 'recent';
    try {
      expect(loadCrawlerConfig().mode).toBe('recent');
    } finally {
      if (saved === undefined) delete process.env.CRAWLER_MODE;
      else process.env.CRAWLER_MODE = saved;
    }
  });

  it('reads CRAWLER_LEDGER_DIR, falling back to the default when blank', () => {
    expect(loadCrawlerConfig({ CRAWLER_LEDGER_DIR: '/data/ledger' }).ledgerDir).toBe('/data/ledger');
    expect(loadCrawlerConfig({ CRAWLER_LEDGER_DIR: '   ' }).ledgerDir).toBe('/var/lib/ingest-crawler');
  });

  it('defaults the per-store enqueue caps to none and the id-range knobs to off / 50', () => {
    const c = loadCrawlerConfig({});
    expect(c.storeEnqueueCaps).toEqual({});
    expect(c.rangeStores).toEqual([]);
    expect(c.rangeIdsPerRun).toBe(50);
    expect(c.rangeFrontiers).toEqual({});
  });

  it('parses CRAWLER_STORE_ENQUEUE_CAPS as a csv of siteId:cap, trimming whitespace and honoring 0', () => {
    const c = loadCrawlerConfig({ CRAWLER_STORE_ENQUEUE_CAPS: ' anitoys:15 , mfc:30 ,sugotoys:0 ' });
    expect(c.storeEnqueueCaps).toEqual({ anitoys: 15, mfc: 30, sugotoys: 0 });
  });

  it('ignores a malformed per-store cap entry with a WARN, keeping the well-formed ones', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const c = loadCrawlerConfig({ CRAWLER_STORE_ENQUEUE_CAPS: 'anitoys:15,mfc,orzgk:-1,:9,bad site:3,x:1.5,y:abc,mfc:30' });
      expect(c.storeEnqueueCaps).toEqual({ anitoys: 15, mfc: 30 });
      const warned = warn.mock.calls.map((call) => String(call[0]));
      expect(warned.every((m) => m.includes('CRAWLER_STORE_ENQUEUE_CAPS'))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
    }
  });

  it('parses CRAWLER_RANGE_STORES, CRAWLER_RANGE_IDS_PER_RUN and the per-store CRAWLER_RANGE_FRONTIER_<SITEID> seeds', () => {
    const c = loadCrawlerConfig({
      CRAWLER_STORES: 'mfc,orzgk,good-smile',
      CRAWLER_RANGE_STORES: ' mfc , good-smile ',
      CRAWLER_RANGE_IDS_PER_RUN: '25',
      CRAWLER_RANGE_FRONTIER_MFC: '3630000',
      CRAWLER_RANGE_FRONTIER_GOOD_SMILE: '42',
      CRAWLER_RANGE_FRONTIER_ORZGK: 'nope',
    });
    expect(c.rangeStores).toEqual(['mfc', 'good-smile']);
    expect(c.rangeIdsPerRun).toBe(25);
    expect(c.rangeFrontiers).toEqual({ mfc: 3630000, 'good-smile': 42 });
  });

  it('falls back to 50 ids per run on a non-positive or non-numeric CRAWLER_RANGE_IDS_PER_RUN', () => {
    expect(loadCrawlerConfig({ CRAWLER_RANGE_IDS_PER_RUN: '0' }).rangeIdsPerRun).toBe(50);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_IDS_PER_RUN: 'x' }).rangeIdsPerRun).toBe(50);
  });

  it('clamps CRAWLER_RANGE_IDS_PER_RUN to the engine window ceiling (200) with a WARN naming the var', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadCrawlerConfig({ CRAWLER_RANGE_IDS_PER_RUN: '1000' }).rangeIdsPerRun).toBe(200);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('CRAWLER_RANGE_IDS_PER_RUN'))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      // At or below the ceiling nothing is clamped and nothing is warned.
      expect(loadCrawlerConfig({ CRAWLER_RANGE_IDS_PER_RUN: '200' }).rangeIdsPerRun).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * RE-OBSERVATION LANE (D4). `CRAWLER_MODE` grows from a single token into a SUBSET of the phases,
 * and the lane carries its own budget so it can never spend discovery's.
 */
describe('loadCrawlerConfig — the re-observation lane', () => {
  it('defaults: mode both = the two discovery phases, and the lane is OFF for every store', () => {
    const c = loadCrawlerConfig({});
    expect(c.mode).toBe('both');
    expect(c.phases).toEqual(['recent', 'backfill']);
    expect(c.maxReobservePerStore).toBe(0);
    expect(c.storeReobserveCaps).toEqual({});
    expect(c.reobserveMinAgeMs).toBe(12 * 60 * 60 * 1000);
    expect(c.reobserveDryRun).toBe(false);
  });

  it('keeps every legacy CRAWLER_MODE token meaning exactly what it meant', () => {
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'recent' }).phases).toEqual(['recent']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'backfill' }).phases).toEqual(['backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'both' }).phases).toEqual(['recent', 'backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'seed' }).phases).toEqual(['seed']);
  });

  it('CRAWLER_MODE may name any subset, in any order, deduplicated into canonical order', () => {
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'reobserve' }).phases).toEqual(['reobserve']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'reobserve' }).mode).toBe('reobserve');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'both,reobserve' }).phases).toEqual(['recent', 'backfill', 'reobserve']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'both,reobserve' }).mode).toBe('recent,backfill,reobserve');
    expect(loadCrawlerConfig({ CRAWLER_MODE: ' reobserve , recent ' }).phases).toEqual(['recent', 'reobserve']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'reobserve,reobserve' }).phases).toEqual(['reobserve']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'recent,backfill' }).mode).toBe('both');
  });

  it('FAILS on an unrecognised token, naming the token and the accepted grammar — never a silent discovery-only run', () => {
    // A typo used to WARN and then run discovery-only, so `both,reobserv` armed nothing and the only
    // trace was one line in an hourly log. The var's grammar grew a csv in this change, which is
    // exactly when fail-closed is cheap: an unknown token is now fatal at config time.
    for (const bad of ['reobserv', 'both,reobserv', 'nonsense,rubbish', 'reobserve;both', 'both reobserve', 'BOTH', 'Reobserve']) {
      expect(() => loadCrawlerConfig({ CRAWLER_MODE: bad })).toThrow(/CRAWLER_MODE/);
    }
    // the message names the offending token AND what is accepted, so the fix needs no source dive
    try {
      loadCrawlerConfig({ CRAWLER_MODE: 'both,reobserv' });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('reobserv');
      expect(message).toContain('recent');
      expect(message).toContain('backfill');
      expect(message).toContain('reobserve');
      expect(message).toContain('seed');
      expect(message).toContain('both');
    }
  });

  it('never dies on an EMPTY or absent value: an unset variable must not crash-loop the CronJob', () => {
    // A CronJob whose env var is blank (or templated away) must still run the default pass. Only a
    // value that says something we cannot honour is fatal.
    expect(loadCrawlerConfig({}).phases).toEqual(['recent', 'backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: '' }).phases).toEqual(['recent', 'backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: '   ' }).phases).toEqual(['recent', 'backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: ',,,' }).phases).toEqual(['recent', 'backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: ' , both , ' }).phases).toEqual(['recent', 'backfill']);
  });

  it('tolerates duplicates and whitespace, which are not typos', () => {
    expect(loadCrawlerConfig({ CRAWLER_MODE: ' both , reobserve , reobserve ' }).phases).toEqual(['recent', 'backfill', 'reobserve']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'both,both' }).phases).toEqual(['recent', 'backfill']);
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'reobserve,both' }).phases).toEqual(['recent', 'backfill', 'reobserve']);
  });

  it('keeps `seed` EXCLUSIVE: named with other phases it is dropped with a WARN, and the rest still run', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadCrawlerConfig({ CRAWLER_MODE: 'seed,reobserve' }).phases).toEqual(['reobserve']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('seed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('CRAWLER_REOBSERVE_MIN_AGE_H is hours → ms, honours an explicit 0, and ignores junk', () => {
    expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_MIN_AGE_H: '6' }).reobserveMinAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_MIN_AGE_H: '0' }).reobserveMinAgeMs).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_MIN_AGE_H: 'x' }).reobserveMinAgeMs).toBe(12 * 60 * 60 * 1000);
    expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_MIN_AGE_H: '-3' }).reobserveMinAgeMs).toBe(12 * 60 * 60 * 1000);
  });

  it('parses CRAWLER_STORE_REOBSERVE_CAPS exactly like the enqueue caps, warning on a malformed entry', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const c = loadCrawlerConfig({ CRAWLER_STORE_REOBSERVE_CAPS: ' goodsmileus:50 , bbts:20 ,anitoys:0, nope ' });
      expect(c.storeReobserveCaps).toEqual({ goodsmileus: 50, bbts: 20, anitoys: 0 });
      expect(warn.mock.calls.some((call) => String(call[0]).includes('CRAWLER_STORE_REOBSERVE_CAPS'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('CRAWLER_MAX_REOBSERVE_PER_STORE is the global default for the lane and stays 0 (off) unless set', () => {
    expect(loadCrawlerConfig({ CRAWLER_MAX_REOBSERVE_PER_STORE: '25' }).maxReobservePerStore).toBe(25);
    expect(loadCrawlerConfig({ CRAWLER_MAX_REOBSERVE_PER_STORE: '0' }).maxReobservePerStore).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_MAX_REOBSERVE_PER_STORE: 'junk' }).maxReobservePerStore).toBe(0);
  });

  it('a `--dry-run` argv arms the same dry run as the env var (the CronJob operator has both)', () => {
    expect(loadCrawlerConfig({}, ['node', 'run.js', '--dry-run']).reobserveDryRun).toBe(true);
    expect(loadCrawlerConfig({}, ['node', 'run.js']).reobserveDryRun).toBe(false);
    expect(loadCrawlerConfig({}, ['node', 'run.js', '--dry-run=please']).reobserveDryRun).toBe(false);
  });

  it('CRAWLER_REOBSERVE_DRY_RUN arms the dry run; CRAWLER_DRY_RUN is an alias that WARNs it covers this lane only', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_DRY_RUN: '1' }).reobserveDryRun).toBe(true);
      expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_DRY_RUN: 'true' }).reobserveDryRun).toBe(true);
      expect(loadCrawlerConfig({ CRAWLER_REOBSERVE_DRY_RUN: '0' }).reobserveDryRun).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(loadCrawlerConfig({ CRAWLER_DRY_RUN: '1' }).reobserveDryRun).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('CRAWLER_DRY_RUN'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
  it('CRAWLER_RANGE_REANCHOR_H is hours → ms, defaults to a day, honours an explicit 0, and ignores junk', () => {
    expect(loadCrawlerConfig({}).rangeReanchorMs).toBe(24 * 60 * 60 * 1000);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_H: '6' }).rangeReanchorMs).toBe(6 * 60 * 60 * 1000);
    // 0 is "re-anchor every run", not "revert to a day": a cadence knob must not fail SLOW.
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_H: '0' }).rangeReanchorMs).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_H: 'x' }).rangeReanchorMs).toBe(24 * 60 * 60 * 1000);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_H: '-3' }).rangeReanchorMs).toBe(24 * 60 * 60 * 1000);
  });

  it('CRAWLER_RANGE_REANCHOR_MAX_DELTA bounds one re-anchor: 50,000 by default, an explicit 0 honoured, junk ignored', () => {
    expect(loadCrawlerConfig({}).rangeReanchorMaxDelta).toBe(50_000);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_MAX_DELTA: '120000' }).rangeReanchorMaxDelta).toBe(120_000);
    // A safety bound at its most conservative setting must not revert to the generous default.
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_MAX_DELTA: '0' }).rangeReanchorMaxDelta).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_MAX_DELTA: 'lots' }).rangeReanchorMaxDelta).toBe(50_000);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_REANCHOR_MAX_DELTA: '-1' }).rangeReanchorMaxDelta).toBe(50_000);
  });

  it('CRAWLER_RANGE_GAP_BUDGET is the gap sweep own per-run budget and stays 0 (off) unless set', () => {
    expect(loadCrawlerConfig({}).rangeGapBudget).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_GAP_BUDGET: '100' }).rangeGapBudget).toBe(100);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_GAP_BUDGET: '0' }).rangeGapBudget).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_GAP_BUDGET: 'junk' }).rangeGapBudget).toBe(0);
    expect(loadCrawlerConfig({ CRAWLER_RANGE_GAP_BUDGET: '-5' }).rangeGapBudget).toBe(0);
  });

  it('parses CRAWLER_RANGE_GAPS into per-store bands, accepting a range and a single id', () => {
    const c = loadCrawlerConfig({ CRAWLER_RANGE_GAPS: ' mfc:3765216-3801000 , mfc:123456 ,orzgk:10-12 ' });
    expect(c.rangeGaps).toEqual({
      mfc: [
        { from: 3765216, to: 3801000 },
        { from: 123456, to: 123456 },
      ],
      orzgk: [{ from: 10, to: 12 }],
    });
  });

  it('drops a malformed CRAWLER_RANGE_GAPS entry with a WARN naming it, and keeps the well-formed ones', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const c = loadCrawlerConfig({ CRAWLER_RANGE_GAPS: 'mfc:10-12,mfc:20-19,mfc:0-5,mfc:abc,nope,mfc:1.5-9,bad site:1-2' });
      expect(c.rangeGaps).toEqual({ mfc: [{ from: 10, to: 12 }] });
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('CRAWLER_RANGE_GAPS')).length).toBe(6);
    } finally {
      warn.mockRestore();
    }
  });

  it('CRAWLER_RANGE_GAP_DRY_RUN arms the sweep dry run; --dry-run and CRAWLER_DRY_RUN arm BOTH lanes', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadCrawlerConfig({}).rangeGapDryRun).toBe(false);
      expect(loadCrawlerConfig({ CRAWLER_RANGE_GAP_DRY_RUN: '1' }).rangeGapDryRun).toBe(true);
      // Gating only ONE lane would be the worst kind of safety knob: a `--dry-run` the operator
      // believed covered the pass while the sweep went on enqueueing.
      expect(loadCrawlerConfig({}, ['node', 'run.js', '--dry-run']).rangeGapDryRun).toBe(true);
      expect(loadCrawlerConfig({ CRAWLER_DRY_RUN: '1' }).rangeGapDryRun).toBe(true);
      expect(loadCrawlerConfig({ CRAWLER_RANGE_GAP_DRY_RUN: '1' }).reobserveDryRun).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
