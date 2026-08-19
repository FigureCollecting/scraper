/**
 * Type-test fixture: an ExtractContext built WITHOUT batchFetch/officialApi on `scraping`
 * (orzgk Slice B needs a ctx a minimal engine can construct, spec.md §3.1). RED before the
 * 0.4.0 bump (batchFetch/officialApi are required ⇒ "missing properties" error); GREEN
 * after they become optional.
 */
import type {
  ExtractContext,
  ScrapingService,
  ScrapePageResult,
  SiteConfig,
  PluginLogger,
} from '../src/index';

const scraping: ScrapingService = {
  async scrapePage(url: string): Promise<ScrapePageResult> {
    return { html: '', url, title: '' };
  },
  async scrapePageStealth(url: string): Promise<ScrapePageResult> {
    return { html: '', url, title: '' };
  },
  async browserFetch(_url: string): Promise<string> {
    return '';
  },
  async withBrowser<T>(fn: (browser: unknown) => Promise<T>): Promise<T> {
    return fn(undefined);
  },
  async withPage<T>(fn: (page: unknown) => Promise<T>): Promise<T> {
    return fn(undefined);
  },
};

const config: SiteConfig = {
  siteId: 'orzgk',
  name: 'orzgk',
  domains: ['orzgk.com'],
  rateLimit: {
    domain: 'orzgk.com',
    baseDelayMs: 3000,
    minDelayMs: 1500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: [],
};

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const ctx: ExtractContext = { config, scraping, logger };

void ctx;
