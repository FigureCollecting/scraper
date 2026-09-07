/**
 * loadInitiatorConfig — env → InitiatorConfig with safe defaults. The interim
 * ingestion initiator is a bounded, CronJob-driven pass; every knob is env with
 * a conservative default so an unconfigured run is safe.
 */
import { loadInitiatorConfig } from '../../initiator/config';
import { resolveLookupStoreTimeoutMs } from '../../driver/assembleLookup';

describe('loadInitiatorConfig', () => {
  it('applies safe defaults when env is empty', () => {
    const c = loadInitiatorConfig({});
    expect(c.scraperServiceUrl).toBe('http://localhost:3050');
    expect(c.stores).toEqual(['orzgk', 'amiami', 'gkloot', 'goodsmileus', 'fnc', 'solaris', 'projectke']);
    expect(c.terms.length).toBeGreaterThan(0);
    expect(c.mode).toBe('listed');
    expect(c.maxConcurrency).toBe(2);
    expect(c.maxRequests).toBeGreaterThan(0);
    expect(c.maxUrlsPerStore).toBeGreaterThan(0);
    expect(c.requestSpacingMs).toBeGreaterThan(0);
    expect(c.requestTimeoutMs).toBeGreaterThan(0);
    expect(c.lookupRetryDelayMs).toBe(5000);
  });

  it('parses csv stores/terms, trimming blanks and whitespace', () => {
    const c = loadInitiatorConfig({ INITIATOR_STORES: ' amiami , , gkloot ', INITIATOR_TERMS: 'lucy, tomie ,' });
    expect(c.stores).toEqual(['amiami', 'gkloot']);
    expect(c.terms).toEqual(['lucy', 'tomie']);
  });

  it('parses numeric knobs', () => {
    const c = loadInitiatorConfig({
      INITIATOR_MAX_CONCURRENCY: '4',
      INITIATOR_MAX_REQUESTS: '25',
      INITIATOR_MAX_URLS_PER_STORE: '3',
      INITIATOR_REQUEST_SPACING_MS: '750',
      INITIATOR_REQUEST_TIMEOUT_MS: '9000',
      INITIATOR_LOOKUP_RETRY_DELAY_MS: '2500',
    });
    expect(c.maxConcurrency).toBe(4);
    expect(c.maxRequests).toBe(25);
    expect(c.maxUrlsPerStore).toBe(3);
    expect(c.requestSpacingMs).toBe(750);
    expect(c.requestTimeoutMs).toBe(9000);
    expect(c.lookupRetryDelayMs).toBe(2500);
  });

  it('falls back to defaults on non-numeric or negative knobs (concurrency floored at 1)', () => {
    const c = loadInitiatorConfig({
      INITIATOR_MAX_CONCURRENCY: 'abc',
      INITIATOR_MAX_REQUESTS: '-1',
      INITIATOR_MAX_URLS_PER_STORE: '-4',
    });
    expect(c.maxConcurrency).toBe(2);
    expect(c.maxRequests).toBeGreaterThan(0);
    expect(c.maxUrlsPerStore).toBeGreaterThan(0);
    expect(c.maxConcurrency).toBeGreaterThanOrEqual(1);
  });

  it('honors an explicit zero for the budget knobs as a hard clamp (most-conservative egress setting)', () => {
    // A safety limit must not fail OPEN: setting the total-request budget to 0 must
    // clamp egress to zero (the gate honors 0 → dispatch nothing), NOT silently
    // revert to the 40-request default. Likewise MAX_URLS_PER_STORE=0 = enqueue-nothing
    // discovery dry run. maxConcurrency=0 stays defaulted (0 concurrency = deadlock).
    const c = loadInitiatorConfig({ INITIATOR_MAX_REQUESTS: '0', INITIATOR_MAX_URLS_PER_STORE: '0' });
    expect(c.maxRequests).toBe(0);
    expect(c.maxUrlsPerStore).toBe(0);
    const floored = loadInitiatorConfig({ INITIATOR_MAX_CONCURRENCY: '0' });
    expect(floored.maxConcurrency).toBe(2);
  });

  it('honors an explicit zero lookup-retry delay (retry immediately), defaulting junk', () => {
    expect(loadInitiatorConfig({ INITIATOR_LOOKUP_RETRY_DELAY_MS: '0' }).lookupRetryDelayMs).toBe(0);
    expect(loadInitiatorConfig({ INITIATOR_LOOKUP_RETRY_DELAY_MS: 'soon' }).lookupRetryDelayMs).toBe(5000);
    expect(loadInitiatorConfig({ INITIATOR_LOOKUP_RETRY_DELAY_MS: '-1' }).lookupRetryDelayMs).toBe(5000);
  });

  it('honors an explicitly-set empty INITIATOR_STORES as zero stores (operator kill switch)', () => {
    expect(loadInitiatorConfig({ INITIATOR_STORES: '' }).stores).toEqual([]);
    expect(loadInitiatorConfig({ INITIATOR_STORES: '  ' }).stores).toEqual([]);
  });

  it('uses default stores only when INITIATOR_STORES is unset', () => {
    expect(loadInitiatorConfig({}).stores.length).toBe(7);
  });

  it('accepts orderable mode, defaulting anything else to listed', () => {
    expect(loadInitiatorConfig({ INITIATOR_LOOKUP_MODE: 'orderable' }).mode).toBe('orderable');
    expect(loadInitiatorConfig({ INITIATOR_LOOKUP_MODE: 'whatever' }).mode).toBe('listed');
  });

  it('defaults the request budget large enough for the default fan-out AND its ingests', () => {
    // Discovery now costs stores x terms (+ up to one retry per store); the ingest phase
    // needs stores x maxUrlsPerStore on top. An under-sized default silently DROPS
    // discovered URLs on a fault-free pass, so the default must cover the whole shape.
    const c = loadInitiatorConfig({});
    const worstCase = c.stores.length * c.terms.length + c.stores.length + c.stores.length * c.maxUrlsPerStore;
    expect(c.maxRequests).toBeGreaterThanOrEqual(worstCase);
  });

  it('defaults the per-request timeout ABOVE the engine per-store search bound', () => {
    // The engine bounds each store's search by LOOKUP_STORE_TIMEOUT_MS (15000 default) and
    // then still has to assemble and serialize; an equal client abort always fires first,
    // which is the 2026-09-07 09:00Z failure shape reduced to one store.
    expect(loadInitiatorConfig({}).requestTimeoutMs).toBeGreaterThan(resolveLookupStoreTimeoutMs({}));
  });

  it('defaults a pass wall-clock deadline that fits inside an hourly schedule', () => {
    const c = loadInitiatorConfig({});
    expect(c.passDeadlineMs).toBeGreaterThan(0);
    expect(c.passDeadlineMs).toBeLessThan(60 * 60 * 1000);
    expect(loadInitiatorConfig({ INITIATOR_PASS_DEADLINE_MS: '120000' }).passDeadlineMs).toBe(120000);
    expect(loadInitiatorConfig({ INITIATOR_PASS_DEADLINE_MS: '0' }).passDeadlineMs).toBe(0); // explicit 0 = no deadline
    expect(loadInitiatorConfig({ INITIATOR_PASS_DEADLINE_MS: 'soon' }).passDeadlineMs).toBe(c.passDeadlineMs);
  });

  it('trims a trailing slash from SCRAPER_SERVICE_URL', () => {
    expect(loadInitiatorConfig({ SCRAPER_SERVICE_URL: 'http://scraper:3050/' }).scraperServiceUrl).toBe('http://scraper:3050');
  });
});
