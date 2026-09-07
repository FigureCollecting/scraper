/**
 * Type-test fixture: the search query-encoding axis (contract 0.8.0) —
 * `RetrievalCapability.bySearch.queryEncoding` and the `QueryEncoding` export. RED before the
 * 0.8.0 bump (queryEncoding does not exist ⇒ an excess-property error, QueryEncoding has no
 * export); GREEN after. A `bySearch` WITHOUT the field must keep compiling (the default = today's
 * single `encodeURIComponent`).
 */
import type { QueryEncoding, StoreCapabilities } from '../src/index';

// anitoys: the store's own `format_keywords` (public_2019.js), declared field by field.
const anitoys: QueryEncoding = {
  strip: ['"'],
  reEncodePercentOf: ['%25', '%3b', '%2f', '%40', '%3a', '%26', '%3d', '%2b', '%24', '%2c', '%23', '%3f'],
  spaces: 'plus',
  lowercase: true,
};

const store: StoreCapabilities = {
  siteId: 'anitoys',
  name: 'Anitoysgk',
  domains: ['anitoysgk.com'],
  rateLimit: {
    domain: 'anitoysgk.com',
    baseDelayMs: 3000,
    minDelayMs: 1500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: true,
  allowedCookies: [],
  retrieval: {
    bySearch: {
      urlTemplate: 'https://www.anitoysgk.com/Search-{q}/list-r1.html',
      scope: 'listed',
      queryEncoding: anitoys,
    },
  },
};

// Every field is optional: a store may declare only the piece it needs.
const spacesOnly: NonNullable<StoreCapabilities['retrieval']> = {
  bySearch: { urlTemplate: 'https://x.test/?q={q}', queryEncoding: { spaces: 'plus' } },
};

// Undeclared ⇒ the engine's default single encodeURIComponent (must still compile).
const undeclared: NonNullable<StoreCapabilities['retrieval']> = {
  bySearch: { urlTemplate: 'https://x.test/?q={q}', scope: 'listed' },
};

const rejectsOtherSpaceModes: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `spaces` is 'percent' | 'plus' (how a space leaves the encoder), nothing else
  bySearch: { urlTemplate: 'https://x.test/?q={q}', queryEncoding: { spaces: 'underscore' } },
};

const stripOnly: NonNullable<StoreCapabilities['retrieval']> = {
  bySearch: { urlTemplate: 'https://x.test/?q={q}', queryEncoding: { strip: ['"'] } },
};

const rejectsNonListStrip: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `strip` is a list of substrings, not a single string
  bySearch: { urlTemplate: 'https://x.test/?q={q}', queryEncoding: { strip: '"' } },
};

void stripOnly;
void rejectsNonListStrip;
void anitoys;
void store;
void spacesOnly;
void undeclared;
void rejectsOtherSpaceModes;
