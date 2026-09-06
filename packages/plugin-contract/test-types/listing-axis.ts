/**
 * Type-test fixture: the catalog-listing axis (contract 0.6.0) — `RetrievalCapability.byListing`,
 * `ListingPage`, and the OPTIONAL `ExtractionRuleset.extractListing()` parser. RED before the
 * 0.6.0 bump (byListing / extractListing do not exist ⇒ excess-property errors, ListingPage has no
 * export); GREEN after. `existing-two-arg-ruleset.ts` remains the guard that a ruleset WITHOUT
 * extractListing still compiles.
 */
import type {
  ExtractionRuleset,
  ExtractedData,
  ValidationResult,
  ExtractContext,
  ListingPage,
  StoreCapabilities,
} from '../src/index';

const store: StoreCapabilities = {
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
  retrieval: {
    byId: { urlTemplate: 'https://www.orzgk.com/wp-json/wc/store/v1/products/{id}', idKind: 'store-internal' },
    byListing: {
      urlTemplate: 'https://www.orzgk.com/wp-json/wc/store/v1/products?orderby=date&order=desc&per_page=100&page={page}',
      pageStart: 1,
      maxPerPage: 100,
      order: 'newest',
    },
  },
};

// The minimal declaration: only the template and the (sole) order literal are required.
const minimalListing: NonNullable<StoreCapabilities['retrieval']> = {
  byListing: { urlTemplate: 'https://solarisjapan.com/products.json?limit=250&page={page}', order: 'newest' },
};

const rejectsOtherOrders: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `order` is the literal 'newest' (newest-first is the only order the feeder reasons about)
  byListing: { urlTemplate: 'https://x.test/?page={page}', order: 'oldest' },
};

const page: ListingPage = { items: [{ itemId: '68064530' }, { itemId: 'noir-black-rabbit-14825', url: '/products/noir-black-rabbit-14825' }], hasMore: true, nextPage: 2 };
const lastPage: ListingPage = { items: [] }; // hasMore / nextPage are optional

const syncRuleset: ExtractionRuleset = {
  siteId: 'orzgk',
  version: '1.2',
  extract(html: string, url: string): ExtractedData {
    return {
      source: { site: 'orzgk', itemId: '1', extractedAt: new Date().toISOString() },
      fields: { html, url },
      warnings: [],
    };
  },
  validate(_data: ExtractedData): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  },
  extractListing(body: string, url: string, ctx?: ExtractContext): ListingPage {
    void ctx;
    return { items: [{ itemId: body.length.toString(), url }] };
  },
};

const asyncRuleset: ExtractionRuleset = {
  ...syncRuleset,
  async extractListing(body: string, url: string): Promise<ListingPage> {
    void body;
    return { items: [{ itemId: 'a', url }], hasMore: false };
  },
};

void store;
void minimalListing;
void rejectsOtherOrders;
void page;
void lastPage;
void syncRuleset;
void asyncRuleset;
