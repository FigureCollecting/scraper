/**
 * Type-test fixture: the per-store browser NAVIGATION budget (contract 0.11.0) —
 * `SearchFetch.navTimeoutMs`. RED before the bump (the field does not exist ⇒ an excess-property
 * error); GREEN after. `existing-two-arg-ruleset.ts` remains the guard that a store declaring
 * nothing still compiles.
 */
import type { SearchFetch, StoreCapabilities } from '../src/index';

/** The slow-by-construction posture: a gated store on the browser lane that needs a wider budget. */
const slowGatedStore: StoreCapabilities = {
  siteId: 'sugotoys',
  name: 'Sugo Toys',
  domains: ['sugotoys.com.au'],
  rateLimit: {
    domain: 'sugotoys.com.au',
    baseDelayMs: 5000,
    minDelayMs: 5000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: true,
  allowedCookies: [],
  searchFetch: {
    transport: 'browser',
    access: 'cloudflare',
    egress: 'residential',
    navTimeoutMs: 60000,
  },
};

/** It stands alone — a store may widen its navigation budget without declaring anything else. */
const budgetOnly: SearchFetch = { transport: 'browser', navTimeoutMs: 45000 };

/** Undeclared (today's stores) still compiles — the 0.11.0 bump is additive. */
const undeclared: SearchFetch = { transport: 'browser', access: 'cloudflare' };

const rejectsWrongType: SearchFetch = {
  transport: 'browser',
  // @ts-expect-error — navTimeoutMs is a number of milliseconds, not a string
  navTimeoutMs: '60s',
};

const budgetFromStore: number | undefined = slowGatedStore.searchFetch?.navTimeoutMs;

void slowGatedStore;
void budgetOnly;
void undeclared;
void rejectsWrongType;
void budgetFromStore;
