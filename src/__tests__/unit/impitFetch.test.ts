/**
 * createImpitFetch — the browser-TLS-impersonating HTTP body fetch (impit). Unit-tested with an
 * injected fake impit so it never loads the native binary: verifies the default profile, per-store
 * profile + header/UA merge, and one-instance-per-profile caching.
 */
import { createImpitFetch, type ImpitLike } from '../../services/impitFetch';

describe('createImpitFetch', () => {
  it('fetches via impit with the default chrome142 profile and returns the body text', async () => {
    const calls: Array<{ browser: string; url: string; init: any }> = [];
    const fake = (browser: string): ImpitLike => ({
      fetch: async (url, init) => { calls.push({ browser, url, init }); return { text: async () => '{"items":[]}' }; },
    });

    const impitFetch = createImpitFetch(fake);
    const body = await impitFetch('https://api.amiami.com/api/v1.0/items?s_keywords=tomie');

    expect(body).toBe('{"items":[]}');
    expect(calls[0].browser).toBe('chrome142'); // engine default profile
    expect(calls[0].url).toBe('https://api.amiami.com/api/v1.0/items?s_keywords=tomie');
    expect(calls[0].init.method).toBe('GET');
  });

  it('uses the store-specified browser profile and merges headers + userAgent', async () => {
    let seen: { browser: string; init: any } | undefined;
    const fake = (browser: string): ImpitLike => ({
      fetch: async (_url, init) => { seen = { browser, init }; return { text: async () => 'ok' }; },
    });

    const impitFetch = createImpitFetch(fake);
    await impitFetch('https://x.test/s', {
      browser: 'chrome124',
      headers: { 'X-User-Key': 'amiami_dev' },
      userAgent: 'python-amiami_dev',
    });

    expect(seen?.browser).toBe('chrome124');
    expect(seen?.init.headers).toEqual({ 'User-Agent': 'python-amiami_dev', 'X-User-Key': 'amiami_dev' });
  });

  it('caches one impit instance per profile (reuses across calls, rebuilds only for a new profile)', async () => {
    let builds = 0;
    const fake = (_browser: string): ImpitLike => { builds++; return { fetch: async () => ({ text: async () => 'ok' }) }; };

    const impitFetch = createImpitFetch(fake);
    await impitFetch('https://x.test/a', { browser: 'chrome142' });
    await impitFetch('https://x.test/b', { browser: 'chrome142' }); // same profile → reuse
    await impitFetch('https://x.test/c', { browser: 'chrome124' }); // new profile → build

    expect(builds).toBe(2);
  });
});

/**
 * Session-priming: a fully session-gated store (anitoysgk) returns a 403 "Just a moment" CHALLENGE
 * to a COLD fetch and the REAL page only after a same-session homepage (prime) GET on the SAME
 * cached Impit. The fake below models exactly that — the prime GET flips an in-jar flag; the target
 * GET returns REAL only while primed.
 */
describe('createImpitFetch — session-prime (prime-once per host, concurrency-safe, capture-neutral)', () => {
  const ORIGIN = 'https://www.anitoysgk.com';
  const PRIME_URL = 'https://www.anitoysgk.com';
  const TARGET = 'https://www.anitoysgk.com/Star-Origin-Studio-1-6-Lucy-p29358268.html';
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';
  const REAL = '<html><body>Star Origin Studio 1/6 Lucy — real product page</body></html>';

  /** A gated Impit: cold target → CHALLENGE; after a prime GET to the origin (same instance) → REAL. */
  function gatedImpit() {
    let primes = 0;   // GETs to the prime/origin URL
    let targets = 0;  // GETs to the product URL
    const make = (_browser: string): ImpitLike => {
      let primed = false; // per-instance jar state (the cf_clearance cookie)
      return {
        fetch: async (url) => {
          if (url === PRIME_URL || url === `${ORIGIN}/`) { primes++; primed = true; return { text: async () => 'homepage' }; }
          targets++;
          const body = primed ? REAL : CHALLENGE;
          return { text: async () => body };
        },
      };
    };
    return { make, primes: () => primes, targets: () => targets };
  }

  it('RED-without-prime posture: an undeclared (no prime) fetch stays a COLD challenge — byte-identical', async () => {
    const g = gatedImpit();
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142' }); // no prime option
    expect(body).toBe(CHALLENGE);       // cold → challenge
    expect(g.primes()).toBe(0);         // never primed
    expect(g.targets()).toBe(1);
  });

  it('GREEN-with-prime: a primed fetch GETs the origin first, then the target returns the REAL page', async () => {
    const g = gatedImpit();
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(body).toBe(REAL);            // primed → real content
    expect(g.primes()).toBe(1);         // primed exactly once
    expect(g.targets()).toBe(1);
  });

  it('primes ONCE per host per session: a second primed fetch to the same host does NOT re-prime', async () => {
    const g = gatedImpit();
    const impitFetch = createImpitFetch(g.make);
    await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    const second = await impitFetch(`${ORIGIN}/another-p1.html`, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(second).toBe(REAL);
    expect(g.primes()).toBe(1);         // still just one prime for the session
    expect(g.targets()).toBe(2);
  });

  it('is concurrency-safe: two parallel first-fetches to a fresh gated host prime only ONCE', async () => {
    const g = gatedImpit();
    const impitFetch = createImpitFetch(g.make);
    const [a, b] = await Promise.all([
      impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } }),
      impitFetch(`${ORIGIN}/second-p2.html`, { browser: 'chrome142', prime: { url: PRIME_URL } }),
    ]);
    expect(a).toBe(REAL);
    expect(b).toBe(REAL);
    expect(g.primes()).toBe(1);         // single in-flight prime — no double-prime, no race
    expect(g.targets()).toBe(2);
  });

  it('re-primes for a DIFFERENT profile (the impit session/cookie jar is per profile)', async () => {
    const g = gatedImpit();
    const impitFetch = createImpitFetch(g.make);
    await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    await impitFetch(TARGET, { browser: 'chrome124', prime: { url: PRIME_URL } }); // fresh jar → prime again
    expect(g.primes()).toBe(2);
  });
});
