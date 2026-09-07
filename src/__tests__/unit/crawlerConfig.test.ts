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

  it('accepts recent / backfill modes, defaulting anything else to both', () => {
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'recent' }).mode).toBe('recent');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'backfill' }).mode).toBe('backfill');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'both' }).mode).toBe('both');
    expect(loadCrawlerConfig({ CRAWLER_MODE: 'whatever' }).mode).toBe('both');
    expect(loadCrawlerConfig({ CRAWLER_MODE: '' }).mode).toBe('both');
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
