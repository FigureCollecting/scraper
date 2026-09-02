/**
 * loadInitiatorConfig — env → InitiatorConfig with safe defaults. The interim
 * ingestion initiator is a bounded, CronJob-driven pass; every knob is env with
 * a conservative default so an unconfigured run is safe.
 */
import { loadInitiatorConfig } from '../../initiator/config';

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
    });
    expect(c.maxConcurrency).toBe(4);
    expect(c.maxRequests).toBe(25);
    expect(c.maxUrlsPerStore).toBe(3);
    expect(c.requestSpacingMs).toBe(750);
    expect(c.requestTimeoutMs).toBe(9000);
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

  it('trims a trailing slash from SCRAPER_SERVICE_URL', () => {
    expect(loadInitiatorConfig({ SCRAPER_SERVICE_URL: 'http://scraper:3050/' }).scraperServiceUrl).toBe('http://scraper:3050');
  });
});
