/**
 * Type-test fixture: the per-store CHALLENGE GATE declaration — `SearchFetch.access` and the
 * `StoreAccess` export. A store that says `access: 'cloudflare'` tells the engine's browser lane to
 * KEEP its context per host (so the Cloudflare clearance is reused rather than re-earned on every
 * fetch). RED before the field exists (excess-property error, missing export); GREEN after.
 * `existing-two-arg-ruleset.ts` remains the guard that a store declaring nothing still compiles.
 */
import type { SearchFetch, StoreAccess, StoreCapabilities } from '../src/index';

/** The anitoys posture: browser lane, residential exit, challenge-gated, session-primed. */
const gatedStore: StoreCapabilities = {
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
  requiresBrowser: true,
  allowedCookies: [],
  searchFetch: {
    transport: 'browser',
    egress: 'residential',
    access: 'cloudflare',
    sessionPrime: true,
  },
};

/** `open` is the explicit form of the default; undeclared stays legal (the field is additive). */
const openStore: SearchFetch = { transport: 'http', access: 'open' };
const undeclared: SearchFetch = { transport: 'http' };

const rejectsUnknownAccess: SearchFetch = {
  transport: 'browser',
  // @ts-expect-error — `access` is the closed union 'open' | 'cloudflare'
  access: 'captcha',
};

const access: StoreAccess = 'cloudflare';
const accessFromStore: StoreAccess | undefined = gatedStore.searchFetch?.access;

void gatedStore;
void openStore;
void undeclared;
void rejectsUnknownAccess;
void access;
void accessFromStore;
