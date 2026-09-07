/**
 * Type-test fixture: per-store EGRESS selection and browser-lane READINESS (contract 0.7.0) —
 * `SearchFetch.egress` and `SearchFetch.waitFor`, plus the `EgressMode` / `WaitForReadiness`
 * exports the engine consumes. RED before the 0.7.0 bump (neither field exists ⇒ excess-property
 * errors, neither type is exported); GREEN after. `existing-two-arg-ruleset.ts` remains the guard
 * that a store WITHOUT either field still compiles.
 */
import type {
  EgressMode,
  SearchFetch,
  StoreCapabilities,
  WaitForReadiness,
} from '../src/index';

/** The CF-cohort posture: impit through the residential proxy, primed, on a declared profile. */
const residentialStore: StoreCapabilities = {
  siteId: 'anitoys',
  name: 'Anitoys GK',
  domains: ['anitoysgk.com'],
  rateLimit: {
    domain: 'anitoysgk.com',
    baseDelayMs: 5000,
    minDelayMs: 5000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: [],
  searchFetch: {
    transport: 'impersonate',
    browser: 'chrome142',
    egress: 'residential',
    sessionPrime: { primeUrl: 'https://www.anitoysgk.com' },
  },
};

/** The PWA storefront posture: browser lane that WAITS for the product to render before capture. */
const pwaStore: SearchFetch = {
  transport: 'browser',
  waitFor: { selector: '[data-t="product-title"]', networkIdle: true, timeoutMs: 20000 },
};

/** Both halves are independently optional — a selector-only wait, and an explicitly direct store. */
const selectorOnly: SearchFetch = { transport: 'browser', waitFor: { selector: '#price' } };
const networkIdleOnly: SearchFetch = { transport: 'browser', waitFor: { networkIdle: true } };
const emptyWait: SearchFetch = { transport: 'browser', waitFor: {} };
const explicitlyDirect: SearchFetch = { transport: 'http', egress: 'direct' };

/** Undeclared (today's stores) still compiles — the 0.7.0 bump is additive. */
const undeclared: SearchFetch = { transport: 'impersonate', browser: 'chrome142' };

const rejectsUnknownEgress: SearchFetch = {
  transport: 'impersonate',
  // @ts-expect-error — `egress` is the closed union 'direct' | 'residential'
  egress: 'mobile',
};

const rejectsUnknownWaitForKey: SearchFetch = {
  transport: 'browser',
  // @ts-expect-error — waitFor carries only selector / networkIdle / timeoutMs
  waitFor: { selector: '#p', waitUntil: 'load' },
};

const rejectsWrongTimeoutType: SearchFetch = {
  transport: 'browser',
  // @ts-expect-error — timeoutMs is a number of milliseconds, not a string
  waitFor: { timeoutMs: '20s' },
};

/** The named exports the engine's lanes/dispatchers import (they must exist, and be assignable). */
const mode: EgressMode = 'residential';
const direct: EgressMode = 'direct';
const readiness: WaitForReadiness = { selector: '.product', networkIdle: false, timeoutMs: 1000 };
const readinessFromStore: WaitForReadiness | undefined = pwaStore.waitFor;
const modeFromStore: EgressMode | undefined = residentialStore.searchFetch?.egress;

void residentialStore;
void pwaStore;
void selectorOnly;
void networkIdleOnly;
void emptyWait;
void explicitlyDirect;
void undeclared;
void rejectsUnknownEgress;
void rejectsUnknownWaitForKey;
void rejectsWrongTimeoutType;
void mode;
void direct;
void readiness;
void readinessFromStore;
void modeFromStore;
