/**
 * createImpitFetch — the browser-TLS-impersonating HTTP body fetch (impit). Unit-tested with an
 * injected fake impit so it never loads the native binary: verifies the default profile, per-store
 * profile + header/UA merge, and one-instance-per-profile caching.
 */
import { createImpitFetch, type ImpitLike, type CookieJarLike } from '../../services/impitFetch';

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
 * to a COLD fetch and the REAL page only after a same-session homepage (prime) GET that lands the
 * cf_clearance cookie — which the SAME cached Impit must then SEND on the target fetch.
 *
 * The fakes below are FAITHFUL to real impit 0.14.3: an Impit is STATELESS unless a cookie jar is
 * threaded into it (without a jar impit stores/sends no cookies across requests). CF's clearance
 * lives ONLY in that jar — the prime GET writes `cf_clearance` into the jar the transport threads
 * through, and the target GET returns REAL only when that SAME jar hands the cookie back. If the
 * transport threads NO jar (the statelessness bug), every target stays a cold CHALLENGE — the prime
 * is inert. (The earlier fake modeled persistence with a bare in-instance boolean the real transport
 * never had, giving false green; these fakes cannot pass unless a jar is genuinely threaded.)
 */
describe('createImpitFetch — session-prime (jar-carried clearance, prime-once, concurrency-safe, TTL + challenge re-prime)', () => {
  const ORIGIN = 'https://www.anitoysgk.com';
  const PRIME_URL = 'https://www.anitoysgk.com';
  const TARGET = 'https://www.anitoysgk.com/Star-Origin-Studio-1-6-Lucy-p29358268.html';
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';
  const REAL = '<html><body>Star Origin Studio 1/6 Lucy — real product page</body></html>';
  const isPrime = (url: string) => url === PRIME_URL || url === `${ORIGIN}/`;

  /**
   * A gated Impit that carries clearance ONLY through a threaded cookie jar: the prime GET writes
   * cf_clearance into `jar`; the target GET returns REAL only when `jar` (the SAME object the
   * transport must thread) hands it back. `jar` undefined (no jar threaded ⇒ the statelessness bug)
   * ⇒ the target stays a cold CHALLENGE.
   */
  function jarGatedImpit() {
    let primes = 0;   // GETs to the prime/origin URL
    let targets = 0;  // GETs to the product URL
    const make = (_browser: string, jar?: CookieJarLike): ImpitLike => ({
      fetch: async (url) => {
        if (isPrime(url)) {
          primes++;
          await jar?.setCookie?.('cf_clearance=ok; Path=/', url); // CF mints clearance on the prime response
          return { text: async () => 'homepage' };
        }
        targets++;
        const cookies = (await jar?.getCookieString?.(url)) ?? '';
        return { text: async () => (cookies.includes('cf_clearance') ? REAL : CHALLENGE) };
      },
    });
    return { make, primes: () => primes, targets: () => targets };
  }

  it('no-prime posture: an undeclared (no prime) fetch stays a COLD challenge — byte-identical, jar never seeded', async () => {
    const g = jarGatedImpit();
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142' }); // no prime option
    expect(body).toBe(CHALLENGE);       // cold → challenge
    expect(g.primes()).toBe(0);         // never primed
    expect(g.targets()).toBe(1);
  });

  it('skips priming (no crash) when the prime URL is unparseable — the target fetch still proceeds cold', async () => {
    const g = jarGatedImpit();
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: 'not a url' } });
    expect(body).toBe(CHALLENGE);       // no host ⇒ no prime; target fetched cold, gracefully
    expect(g.primes()).toBe(0);         // priming skipped, not attempted
    expect(g.targets()).toBe(1);
  });

  it('GREEN-with-prime: the prime GET seeds cf_clearance in the threaded jar and the target sends it → REAL page', async () => {
    const g = jarGatedImpit();
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(body).toBe(REAL);            // primed → jar carries clearance → real content
    expect(g.primes()).toBe(1);         // primed exactly once
    expect(g.targets()).toBe(1);
  });

  it('primes ONCE per host per session: a second primed fetch to the same host does NOT re-prime', async () => {
    const g = jarGatedImpit();
    const impitFetch = createImpitFetch(g.make);
    await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    const second = await impitFetch(`${ORIGIN}/another-p1.html`, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(second).toBe(REAL);          // jar still carries clearance from the first prime
    expect(g.primes()).toBe(1);         // still just one prime for the session
    expect(g.targets()).toBe(2);
  });

  it('is concurrency-safe: two parallel first-fetches to a fresh gated host prime only ONCE', async () => {
    const g = jarGatedImpit();
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

  it('re-primes for a DIFFERENT profile (the impit session + cookie jar are per profile)', async () => {
    const g = jarGatedImpit();
    const impitFetch = createImpitFetch(g.make);
    await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    const other = await impitFetch(TARGET, { browser: 'chrome124', prime: { url: PRIME_URL } }); // fresh jar → prime again
    expect(other).toBe(REAL);           // the chrome124 jar was seeded by its own prime
    expect(g.primes()).toBe(2);
  });

  it('re-primes after the clearance TTL lapses (a stale primed-marker is not pinned forever)', async () => {
    const g = jarGatedImpit();
    let clock = 1_000_000;
    const impitFetch = createImpitFetch(g.make, { now: () => clock, primeTtlMs: 60_000 });
    const first = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(first).toBe(REAL);
    expect(g.primes()).toBe(1);
    clock += 60_001; // clearance lifetime elapsed
    const second = await impitFetch(`${ORIGIN}/after-ttl-p3.html`, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(second).toBe(REAL);
    expect(g.primes()).toBe(2);         // stale host re-primed after TTL
  });

  it('does NOT re-prime before the TTL lapses (a fresh prime is reused within its window)', async () => {
    const g = jarGatedImpit();
    let clock = 1_000_000;
    const impitFetch = createImpitFetch(g.make, { now: () => clock, primeTtlMs: 60_000 });
    await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    clock += 59_999; // still inside the TTL window
    const second = await impitFetch(`${ORIGIN}/within-ttl-p4.html`, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(second).toBe(REAL);
    expect(g.primes()).toBe(1);         // reused, not re-primed
  });

  /**
   * Like jarGatedImpit, but the test can EXPIRE the clearance mid-session: after expire() the gate
   * ignores the jar cookie (a lapsed / freshly-rotated CF challenge) until the NEXT prime re-mints it.
   */
  function expiringJarGatedImpit() {
    let primes = 0;
    let targets = 0;
    let valid = false; // whether the current clearance still satisfies the gate
    const make = (_browser: string, jar?: CookieJarLike): ImpitLike => ({
      fetch: async (url) => {
        if (isPrime(url)) {
          primes++;
          valid = true;
          await jar?.setCookie?.('cf_clearance=ok; Path=/', url);
          return { text: async () => 'homepage' };
        }
        targets++;
        const cookies = (await jar?.getCookieString?.(url)) ?? '';
        const cleared = valid && cookies.includes('cf_clearance');
        return { text: async () => (cleared ? REAL : CHALLENGE) };
      },
    });
    return { make, primes: () => primes, targets: () => targets, expire: () => { valid = false; } };
  }

  it('re-primes when a still-"primed" host returns a fresh challenge (clearance went stale mid-session)', async () => {
    const g = expiringJarGatedImpit();
    const impitFetch = createImpitFetch(g.make); // default TTL (marker still fresh) — only challenge-detection can save it
    const first = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(first).toBe(REAL);
    expect(g.primes()).toBe(1);
    g.expire(); // clearance invalidated by CF, but the primed-marker is still within its TTL
    const second = await impitFetch(`${ORIGIN}/stale-p5.html`, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(second).toBe(REAL);          // challenge detected → invalidate → re-prime → refetch → REAL
    expect(g.primes()).toBe(2);         // one initial prime + one challenge-triggered re-prime
    expect(g.targets()).toBe(3);        // first target + (stale target + retried target)
  });

  /** A gate a homepage prime can NEVER clear (prime seeds the jar, but the target still challenges). */
  function unclearableJarImpit() {
    let primes = 0;
    let targets = 0;
    const make = (_browser: string, jar?: CookieJarLike): ImpitLike => ({
      fetch: async (url) => {
        if (isPrime(url)) { primes++; await jar?.setCookie?.('cf_clearance=ok; Path=/', url); return { text: async () => 'homepage' }; }
        targets++;
        return { text: async () => CHALLENGE };
      },
    });
    return { make, primes: () => primes, targets: () => targets };
  }

  it('bounds the challenge re-prime to a SINGLE retry (a persistent challenge is returned, never looped)', async () => {
    const g = unclearableJarImpit();
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(body).toBe(CHALLENGE);       // still challenged after the one retry — returned, not looped
    expect(g.primes()).toBe(2);         // initial prime + exactly one re-prime, then stop
    expect(g.targets()).toBe(2);        // target fetched twice (initial + one retry) — no infinite loop
  });
});
