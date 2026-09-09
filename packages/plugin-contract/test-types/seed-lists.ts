/**
 * Type-test fixture: DECLARED SEED LISTS (contract 0.9.0) — `RetrievalCapability.seedLists`, the
 * `SeedList` export, and the OPTIONAL `ExtractionRuleset.extractSeedList()` parser. RED before the
 * 0.9.0 bump (seedLists / extractSeedList do not exist ⇒ excess-property errors, `SeedList` has no
 * export); GREEN after. `existing-two-arg-ruleset.ts` remains the guard that a ruleset WITHOUT the
 * new parser still compiles, and `listing-axis.ts` that the byListing axis is untouched.
 */
import type {
  ExtractionRuleset,
  ExtractedData,
  ValidationResult,
  ListingPage,
  SeedList,
  StoreCapabilities,
} from '../src/index';

const store: StoreCapabilities = {
  siteId: 'examplestore',
  name: 'Example Store',
  domains: ['example.test'],
  rateLimit: {
    domain: 'example.test',
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
    byId: { urlTemplate: 'https://example.test/item/{id}', idKind: 'store-internal' },
    seedLists: [
      { id: 'new-arrivals', url: 'https://example.test/new', cadence: 'daily', note: 'front-page shelf' },
      { id: 'staff-picks', url: 'https://example.test/picks', cadence: 'weekly' },
    ],
  },
};

// The minimal entry: id + url + cadence. `note` is optional.
const minimal: SeedList = { id: 'a', url: 'https://example.test/a', cadence: 'weekly' };

const rejectsOtherCadences: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `cadence` is 'weekly' | 'daily' (a seed list is a SLOW poll, never a per-run walk)
  seedLists: [{ id: 'a', url: 'https://example.test/a', cadence: 'hourly' }],
};

const rejectsMissingUrl: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — a seed list is URL-ADDRESSABLE: `url` is required
  seedLists: [{ id: 'a', cadence: 'weekly' }],
};

// A seed list is parsed into the SAME shape as a listing page — with `hasMore` always false.
const seedPage: ListingPage = { items: [{ itemId: '1' }, { itemId: 'slug-2', url: '/products/slug-2' }], hasMore: false };

const syncRuleset: ExtractionRuleset = {
  siteId: 'examplestore',
  version: '1.0',
  extract(html: string, url: string): ExtractedData {
    return {
      source: { site: 'examplestore', itemId: '1', extractedAt: new Date().toISOString() },
      fields: { html, url },
      warnings: [],
    };
  },
  validate(_data: ExtractedData): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  },
  extractSeedList(body: string, listId: string): ListingPage {
    return { items: [{ itemId: `${listId}-${body.length}` }], hasMore: false };
  },
};

const asyncRuleset: ExtractionRuleset = {
  ...syncRuleset,
  async extractSeedList(body: string, listId: string): Promise<ListingPage> {
    void body;
    return { items: [{ itemId: listId }], hasMore: false };
  },
};

void store;
void minimal;
void rejectsOtherCadences;
void rejectsMissingUrl;
void seedPage;
void syncRuleset;
void asyncRuleset;
