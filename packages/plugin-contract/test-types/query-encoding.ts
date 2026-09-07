/**
 * Type-test fixture: the search query-encoding axis (contract 0.8.0) —
 * `RetrievalCapability.bySearch.queryEncoding` and the `QueryEncoding` export. RED before the
 * 0.8.0 bump (queryEncoding does not exist ⇒ an excess-property error, QueryEncoding has no
 * export); GREEN after. A `bySearch` WITHOUT the field must keep compiling (the default = today's
 * single `encodeURIComponent`).
 *
 * The store here is synthetic on purpose: which escapes, strips and case-folding a real store needs
 * belong to that store's own plugin profile, never to the contract.
 */
import type { QueryEncoding, StoreCapabilities } from '../src/index';

// A path-segment search route: '/' must reach it as data ('%252f'), spaces as '+', segment folded.
const pathSegmentRoute: QueryEncoding = {
  strip: ['"'],
  reEncodePercentOf: ['%2f', '%3a'],
  spaces: 'plus',
  lowercase: true,
};

const store: StoreCapabilities = {
  siteId: 'example',
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
  requiresBrowser: true,
  allowedCookies: [],
  retrieval: {
    bySearch: {
      urlTemplate: 'https://example.test/Search-{q}/list-r1.html',
      scope: 'listed',
      queryEncoding: pathSegmentRoute,
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
void pathSegmentRoute;
void store;
void spacesOnly;
void undeclared;
void rejectsOtherSpaceModes;
