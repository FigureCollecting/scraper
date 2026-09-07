/**
 * createImpitFetch — the browser-TLS-impersonating HTTP body fetch (impit). Unit-tested with an
 * injected fake impit so it never loads the native binary: verifies the default profile, per-store
 * profile + header/UA merge, and one-instance-per-profile caching.
 */
// Timeout wiring (G-R2): the seam spy below proves createImpitFetch hands TIMEOUT_MS to *a* factory,
// but only the REAL defaultMakeImpit forwards it into `new Impit({ timeout })`. tsconfig module=commonjs
// makes that factory's `await import('impit')` a mockable require, so mocking 'impit' here lets the
// default factory run without the native binary and pins the forwarded timeout (a hard-coded 15000 is
// caught). The accumulator is `mock`-prefixed so jest's mock-factory hoisting permits the out-of-scope
// reference; it stays inert for every existing test (they inject a fake factory and never load impit).
const mockImpitCtorOpts: Array<Record<string, unknown>> = [];
jest.mock('impit', () => ({
  Impit: function MockImpit(
    this: { fetch: () => Promise<{ text(): Promise<string> }> },
    opts: Record<string, unknown>,
  ) {
    mockImpitCtorOpts.push(opts);
    this.fetch = async () => ({ text: async () => 'ok' });
  },
}));

import { createImpitFetch, resolveImpitTimeoutMs, type ImpitLike, type CookieJarLike } from '../../services/impitFetch';

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

  it('constructs the impit instance with the resolved per-request timeout (default 30000 ms)', async () => {
    // The module resolves IMPIT_TIMEOUT_MS once at load; createImpitFetch must hand that value to the
    // factory it indirects Impit construction through (the seam the fakes above stand in for), so a
    // slow session-gated store's prime + target GETs share the configured budget rather than the old 15s.
    let seenTimeout: number | undefined;
    const spy = (_browser: string, _jar: CookieJarLike, timeoutMs: number): ImpitLike => {
      seenTimeout = timeoutMs;
      return { fetch: async () => ({ text: async () => 'ok' }) };
    };

    const impitFetch = createImpitFetch(spy);
    await impitFetch('https://x.test/s');

    expect(seenTimeout).toBe(30000);                              // module-load default (no IMPIT_TIMEOUT_MS in env)
    expect(seenTimeout).toBe(resolveImpitTimeoutMs(process.env)); // …and it is exactly the resolver's value
  });
});

/**
 * Timeout wiring end-to-end: IMPIT_TIMEOUT_MS is resolved ONCE at module load and must thread all the
 * way into `new Impit({ timeout })`. The seam-only construction test above cannot see either end, so
 * two mutants survive it: (G-R2) the real defaultMakeImpit hard-coding `timeout: 15000`, and (G-R1) the
 * module-load read ignoring process.env. Each test isolates a fresh module load (TIMEOUT_MS is cached at
 * first load, so an env override is only visible to an isolated re-require) to kill one of them.
 */
describe('createImpitFetch — timeout wiring (IMPIT_TIMEOUT_MS → module load → Impit constructor)', () => {
  const MODULE_PATH = '../../services/impitFetch';
  const ORIGINAL = process.env.IMPIT_TIMEOUT_MS;
  beforeEach(() => { mockImpitCtorOpts.length = 0; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.IMPIT_TIMEOUT_MS;
    else process.env.IMPIT_TIMEOUT_MS = ORIGINAL;
  });

  it('the REAL default factory forwards the resolved timeout into new Impit({ timeout }) (default 30000 ms, not a hard-coded 15000)', async () => {
    // Drive defaultMakeImpit for real (not the injectable seam) with 'impit' mocked out, on an isolated
    // load with no override, and assert the resolved default is forwarded into the native constructor.
    delete process.env.IMPIT_TIMEOUT_MS;
    let mod!: { createImpitFetch: typeof createImpitFetch };
    jest.isolateModules(() => { mod = require(MODULE_PATH); });
    await mod.createImpitFetch()('https://x.test/s'); // DEFAULT factory → defaultMakeImpit → mocked Impit
    expect(mockImpitCtorOpts).toHaveLength(1);
    expect(mockImpitCtorOpts[0]).toMatchObject({ followRedirects: true });
    expect(mockImpitCtorOpts[0].timeout).toBe(30000);
  });

  it('threads an IMPIT_TIMEOUT_MS override through an isolated module load into the factory (env is actually read at L34)', async () => {
    // Set the env, re-require in isolation so a fresh TIMEOUT_MS is resolved from it, and assert the
    // value reaches the factory seam — an env-ignoring resolveImpitTimeoutMs({}) yields 30000 and fails.
    process.env.IMPIT_TIMEOUT_MS = '45000';
    let seenTimeout: number | undefined;
    const spy = (_browser: string, _jar: CookieJarLike, timeoutMs: number): ImpitLike => {
      seenTimeout = timeoutMs;
      return { fetch: async () => ({ text: async () => 'ok' }) };
    };
    let mod!: { createImpitFetch: typeof createImpitFetch };
    jest.isolateModules(() => { mod = require(MODULE_PATH); });
    await mod.createImpitFetch(spy)('https://x.test/s');
    expect(seenTimeout).toBe(45000);
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

  /**
   * A gate whose target ALWAYS returns `targetBody` after the prime seeds the jar — pins exactly
   * which bodies the challenge-detection re-prime treats as a CHALLENGE (re-prime once) vs REAL
   * content (no re-prime). Guards impit's `looksLikeChallenge` (which delegates to the shared
   * conservative detector): the injected Bot-Management telemetry script that rides on ordinary 200
   * pages must NOT trigger a re-prime (RS-1/RD-1), while genuine challenge/block markers must.
   */
  function fixedTargetJarImpit(targetBody: string) {
    let primes = 0;
    let targets = 0;
    const make = (_browser: string, jar?: CookieJarLike): ImpitLike => ({
      fetch: async (url) => {
        if (isPrime(url)) { primes++; await jar?.setCookie?.('cf_clearance=ok; Path=/', url); return { text: async () => 'homepage' }; }
        targets++;
        return { text: async () => targetBody };
      },
    });
    return { make, primes: () => primes, targets: () => targets };
  }

  it('does NOT re-prime a primed host whose 200 page carries only injected Bot-Management telemetry (real page, RS-1)', async () => {
    // /cdn-cgi/challenge-platform/scripts/jsd/main.js is telemetry Cloudflare injects into ORDINARY
    // 200 pages — NOT the orchestrate/chl_page challenge loader. looksLikeChallenge must read it as
    // real content, so a primed host is not needlessly re-primed and the real body is returned as-is.
    const TELEMETRY_200 =
      '<html><head><title>Lucy 1/6 — Star Origin Studio</title>' +
      '<script>var a=document.createElement("script");a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";document.head.appendChild(a);</script>' +
      '</head><body>real product page, in stock</body></html>';
    const g = fixedTargetJarImpit(TELEMETRY_200);
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(body).toBe(TELEMETRY_200); // real content returned as-is
    expect(g.primes()).toBe(1);       // primed ONCE — telemetry is not a challenge, no re-prime
    expect(g.targets()).toBe(1);      // target fetched once, not retried
  });

  it('re-primes ONCE for a primed host returning genuine __cf_chl_ / _cf_chl_opt challenge markers', async () => {
    const CHL_MARKERS =
      '<html><head></head><body><script>window._cf_chl_opt={cvId:"3"};window.__cf_chl_managed_tk__="x";</script></body></html>';
    const g = fixedTargetJarImpit(CHL_MARKERS);
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(body).toBe(CHL_MARKERS); // still challenged after the one bounded retry — returned, not looped
    expect(g.primes()).toBe(2);     // initial prime + exactly one challenge-triggered re-prime
    expect(g.targets()).toBe(2);    // target fetched twice (initial + one retry)
  });

  it('re-primes ONCE for a primed host returning a CF block/error page (cf-error-details / Attention Required!)', async () => {
    const BLOCK =
      '<html><head><title>Attention Required! | Cloudflare</title></head>' +
      '<body><div id="cf-error-details">Sorry, you have been blocked</div></body></html>';
    const g = fixedTargetJarImpit(BLOCK);
    const impitFetch = createImpitFetch(g.make);
    const body = await impitFetch(TARGET, { browser: 'chrome142', prime: { url: PRIME_URL } });
    expect(body).toBe(BLOCK);
    expect(g.primes()).toBe(2);     // a block page also triggers exactly one bounded re-prime
    expect(g.targets()).toBe(2);
  });
});

/**
 * resolveImpitTimeoutMs — the pure env→ms resolver for the impit per-request timeout. Absent/invalid
 * (non-numeric, empty, non-positive) → the 30000 ms default; any numeric value is clamped to
 * [5000, 120000] so a typo can neither strangle a slow session-gated store's prime+target GETs nor
 * unbound them. Tested directly (no process.env) so every branch is deterministic.
 */
describe('resolveImpitTimeoutMs', () => {
  const env = (v?: string): NodeJS.ProcessEnv =>
    (v === undefined ? {} : { IMPIT_TIMEOUT_MS: v }) as NodeJS.ProcessEnv;

  it('defaults to 30000 ms when IMPIT_TIMEOUT_MS is absent', () => {
    expect(resolveImpitTimeoutMs(env())).toBe(30000);
  });

  it('accepts an in-range value verbatim', () => {
    expect(resolveImpitTimeoutMs(env('45000'))).toBe(45000);
  });

  it('falls back to 30000 ms for a non-numeric value', () => {
    expect(resolveImpitTimeoutMs(env('abc'))).toBe(30000);
  });

  it('clamps a below-floor value up to 5000 ms', () => {
    expect(resolveImpitTimeoutMs(env('1000'))).toBe(5000);
  });

  it('clamps an above-ceiling value down to 120000 ms', () => {
    expect(resolveImpitTimeoutMs(env('999999'))).toBe(120000);
  });

  it('treats an empty value as absent (default 30000 ms)', () => {
    expect(resolveImpitTimeoutMs(env(''))).toBe(30000);
  });
});

/**
 * Stored-cookie jar seeding (CfCookieStore): the impit lane seeds its per-profile tough-cookie jar
 * with the host's STORED cookies (hand-minted cf_clearance etc.) before the prime/target GETs, on
 * EVERY call (idempotent overwrite), and pins the mint User-Agent (cf_clearance is IP+UA-bound, so
 * the mint UA must beat the store profile's UA and any caller UA). An unknown host is byte-identical
 * to the no-store path. Values below are obviously-fake placeholders.
 */
describe('createImpitFetch — stored-cookie jar seeding + pinned UA (CfCookieStore)', () => {
  const COHORT = 'https://www.anitoysgk.com/Star-Origin-Studio-1-6-Lucy-p29358268.html';
  const PRIME_URL = 'https://www.anitoysgk.com';
  const REAL = '<html><body>real product page</body></html>';
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>cf challenge</body></html>';

  /** A fake CfCookieStore keyed by www-stripped host. */
  const fakeStore = (hosts: Record<string, { cookies?: Record<string, string>; userAgent?: string }>) => {
    const key = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return {
      cookiesFor: (url: string) => (hosts[key(url)]?.cookies ? { ...hosts[key(url)].cookies } : undefined),
      userAgentFor: (url: string) => hosts[key(url)]?.userAgent,
    };
  };

  /** A recording impit: for each GET it reports the Cookie string the threaded jar hands back + the headers sent. */
  function recordingImpit() {
    const gets: Array<{ url: string; cookie: string; headers: Record<string, string> }> = [];
    const make = (_browser: string, jar: CookieJarLike): ImpitLike => ({
      fetch: async (url, init) => {
        // tough-cookie itself throws on an unparseable url — that is the fake's concern, not the seeder's
        let cookie: string;
        try { cookie = String(await jar.getCookieString(url)); } catch { cookie = '<jar-threw>'; }
        gets.push({ url, cookie, headers: init.headers ?? {} });
        return { text: async () => 'ok' };
      },
    });
    return { make, gets };
  }

  it('seeds the session jar with the cohort host\'s stored cookies before the target GET — they are SENT (domain-scoped to the host)', async () => {
    const r = recordingImpit();
    const store = fakeStore({ 'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_1', other: 'FAKE_o' } } });
    const impitFetch = createImpitFetch(r.make, { store });

    await impitFetch(COHORT, { browser: 'chrome142' });

    expect(r.gets).toHaveLength(1);
    expect(r.gets[0].cookie).toContain('cf_clearance=FAKE_cf_1');
    expect(r.gets[0].cookie).toContain('other=FAKE_o');
  });

  it('does NOT seed for a host the store has no entry for — jar empty, headers byte-identical to the no-store path', async () => {
    const r = recordingImpit();
    const store = fakeStore({ 'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_1' } } });
    const impitFetch = createImpitFetch(r.make, { store });

    await impitFetch('https://x.test/s', { browser: 'chrome124', headers: { 'X-User-Key': 'amiami_dev' }, userAgent: 'python-amiami_dev' });

    expect(r.gets[0].cookie).toBe('');
    expect(r.gets[0].headers).toEqual({ 'User-Agent': 'python-amiami_dev', 'X-User-Key': 'amiami_dev' });
  });

  it('UA precedence: the pinned mint UA beats opts.userAgent AND a headers User-Agent; no pin → opts.userAgent; neither → no UA header (profile default)', async () => {
    const r = recordingImpit();
    const store = fakeStore({
      'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_1' }, userAgent: 'Mozilla/5.0 FAKE-MINT-UA' },
      'uaonly.test': { userAgent: 'Mozilla/5.0 FAKE-PIN-ONLY' },
    });
    const impitFetch = createImpitFetch(r.make, { store });

    await impitFetch(COHORT, { userAgent: 'caller-ua', headers: { 'User-Agent': 'header-ua', 'X-K': '1' } });
    await impitFetch('https://uaonly.test/s', { userAgent: 'caller-ua' });
    await impitFetch('https://x.test/s', { userAgent: 'caller-ua' });
    await impitFetch('https://x.test/s');

    expect(r.gets[0].headers).toEqual({ 'User-Agent': 'Mozilla/5.0 FAKE-MINT-UA', 'X-K': '1' }); // pin wins over both
    expect(r.gets[1].headers).toEqual({ 'User-Agent': 'Mozilla/5.0 FAKE-PIN-ONLY' });          // pin without cookies still applies
    expect(r.gets[1].cookie).toBe('');
    expect(r.gets[2].headers).toEqual({ 'User-Agent': 'caller-ua' });                            // no pin → caller UA
    expect(r.gets[3].headers).toEqual({});                                                        // neither → profile default
  });

  it('with a seeded clearance the session-prime path is a plain 200: prime once, target REAL, NO re-prime (the prime itself cannot mint from the pod IP)', async () => {
    // A CF gate the prime can NEVER solve (no Set-Cookie on the prime): only a jar that ALREADY carries
    // the stored clearance gets the real page. Mirrors the live OVH posture.
    let primes = 0;
    let targets = 0;
    const make = (_browser: string, jar: CookieJarLike): ImpitLike => ({
      fetch: async (url) => {
        if (url === PRIME_URL || url === `${PRIME_URL}/`) { primes++; return { text: async () => 'homepage' }; }
        targets++;
        const cookies = String(await jar.getCookieString(url));
        return { text: async () => (cookies.includes('cf_clearance=FAKE_cf_1') ? REAL : CHALLENGE) };
      },
    });
    const store = fakeStore({ 'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_1' } } });
    const impitFetch = createImpitFetch(make, { store });

    const body = await impitFetch(COHORT, { browser: 'chrome142', prime: { url: PRIME_URL } });

    expect(body).toBe(REAL);
    expect(primes).toBe(1);   // primed once (the existing prime discipline is untouched)
    expect(targets).toBe(1);  // no challenge → no bounded re-prime/refetch
  });

  it('re-seeds on EVERY call (idempotent overwrite): a server-rotated jar value is overwritten with the file\'s value on the next fetch', async () => {
    const sent: string[] = [];
    const make = (_browser: string, jar: CookieJarLike): ImpitLike => ({
      fetch: async (url) => {
        sent.push(String(await jar.getCookieString(url)));
        // the server rotates the clearance in the response (Set-Cookie) — CF can't be re-solved from OVH, so the FILE value must win next time
        await jar.setCookie('cf_clearance=ROTATED_BY_SERVER; Domain=.anitoysgk.com; Path=/; Secure', url);
        return { text: async () => 'ok' };
      },
    });
    const store = fakeStore({ 'anitoysgk.com': { cookies: { cf_clearance: 'FAKE_cf_1' } } });
    const impitFetch = createImpitFetch(make, { store });

    await impitFetch(COHORT);
    await impitFetch(COHORT);

    expect(sent).toEqual(['cf_clearance=FAKE_cf_1', 'cf_clearance=FAKE_cf_1']);
  });

  it('a cookie the jar rejects is skipped with ONE warn naming the cookie NAME only; the other cookies seed and the fetch proceeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = recordingImpit();
    // a control character makes tough-cookie throw "Cookie failed to parse" — the real jar is threaded, so this is a real rejection
    const store = fakeStore({ 'anitoysgk.com': { cookies: { broken: 'va\x01lue', cf_clearance: 'FAKE_cf_1' } } });
    const impitFetch = createImpitFetch(r.make, { store });

    expect(await impitFetch(COHORT)).toBe('ok');
    expect(r.gets[0].cookie).toBe('cf_clearance=FAKE_cf_1');
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[CF-COOKIE]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('broken');
    expect(lines[0]).not.toContain('va\x01lue');
    expect(lines[0]).not.toContain('FAKE_cf_1');
    warn.mockRestore();
  });

  it('an unparseable target url is fetched as-is without seeding (no throw from the seeder)', async () => {
    const r = recordingImpit();
    const store = { cookiesFor: () => ({ cf_clearance: 'FAKE_cf_1' }), userAgentFor: () => undefined };
    const impitFetch = createImpitFetch(r.make, { store });
    await expect(impitFetch('not a url')).resolves.toBe('ok');
    expect(r.gets[0].url).toBe('not a url');
  });

  it('seeds over http:// without the Secure attribute so the cookie is actually SENT on a plain-http host', async () => {
    const r = recordingImpit();
    const store = fakeStore({ 'plain.test': { cookies: { sess: 'FAKE_sess_1' } } });
    const impitFetch = createImpitFetch(r.make, { store });
    await impitFetch('http://plain.test/list');
    expect(r.gets[0].cookie).toBe('sess=FAKE_sess_1');
  });

  it('the default factory (no injected store) consults the CfCookieStore singleton — CF_COOKIE_FILE fixture with FAKE values', async () => {
    const { getCfCookieStore, resetCfCookieStore } = require('../../services/cookieJar') as typeof import('../../services/cookieJar');
    const ORIGINAL = process.env.CF_COOKIE_FILE;
    process.env.CF_COOKIE_FILE = require('path').join(__dirname, '../fixtures/cfCookies/cf-cookies.json');
    resetCfCookieStore();
    try {
      expect(getCfCookieStore().cookiesFor('https://anitoysgk.com/')).toBeDefined(); // fixture loaded
      const r = recordingImpit();
      const impitFetch = createImpitFetch(r.make); // NO store option → singleton
      await impitFetch('https://www.myfigurecollection.net/item/1');
      expect(r.gets[0].cookie).toContain('cf_clearance=FAKE_cf_fixture_1');
      expect(r.gets[0].cookie).toContain('PHPSESSID=FAKE_sess_fixture_1');
      expect(r.gets[0].headers).toEqual({ 'User-Agent': 'Mozilla/5.0 FAKE-FIXTURE-MINT-UA' });
    } finally {
      resetCfCookieStore();
      if (ORIGINAL === undefined) delete process.env.CF_COOKIE_FILE; else process.env.CF_COOKIE_FILE = ORIGINAL;
    }
  });
});

/**
 * RESIDENTIAL EGRESS (contract 0.7.0): a store declaring `egress: 'residential'` has its impit
 * fetches routed through the engine's residential proxy. impit 0.14.x takes a `proxyUrl` on the
 * Impit constructor (SOCKS5/HTTP; unsupported when HTTP/3 is on — so the engine never enables it),
 * which means the proxy is a property of the SESSION, not of a request. Two rules follow:
 *   - the session cache must be keyed by (profile, proxy) — a proxied and a direct session for the
 *     same profile must never share one Impit, or they would share its cookie jar and a clearance
 *     minted from the residential IP would be replayed from the node IP (and vice versa);
 *   - an undeclared store must be byte-identical: no `proxyUrl` key reaches the constructor at all.
 */
describe('createImpitFetch — residential egress (proxyUrl threading + per-proxy session isolation)', () => {
  beforeEach(() => { mockImpitCtorOpts.length = 0; });

  const PROXY = 'socks5://egress-proxy.fc.svc.cluster.local:1055';
  const OTHER_PROXY = 'socks5://127.0.0.1:1055';

  /** A factory spy that records the (browser, proxyUrl) pair it was built for, per build. */
  function recordingFactory() {
    const builds: Array<{ browser: string; proxyUrl?: string }> = [];
    const make = (browser: string, _jar: CookieJarLike, _timeoutMs: number, proxyUrl?: string): ImpitLike => {
      builds.push({ browser, ...(proxyUrl ? { proxyUrl } : {}) });
      return { fetch: async () => ({ text: async () => 'ok' }) };
    };
    return { make, builds };
  }

  it('passes the declared proxy through to the Impit factory for a residential store', async () => {
    const f = recordingFactory();
    const impitFetch = createImpitFetch(f.make);
    await impitFetch('https://www.anitoysgk.com/lucy-p29358268.html', { browser: 'chrome142', proxyUrl: PROXY });
    expect(f.builds).toEqual([{ browser: 'chrome142', proxyUrl: PROXY }]);
  });

  it('builds NO proxy for an undeclared store (byte-identical to the pre-egress path)', async () => {
    const f = recordingFactory();
    const impitFetch = createImpitFetch(f.make);
    await impitFetch('https://api.amiami.com/items?s_keywords=tomie', { browser: 'chrome142' });
    expect(f.builds).toEqual([{ browser: 'chrome142' }]);
  });

  it('keys the session cache by (profile, proxy): direct and proxied sessions for ONE profile are SEPARATE Impits', async () => {
    const f = recordingFactory();
    const impitFetch = createImpitFetch(f.make);
    await impitFetch('https://x.test/a', { browser: 'chrome142' });                      // direct
    await impitFetch('https://x.test/b', { browser: 'chrome142', proxyUrl: PROXY });     // proxied → new session
    await impitFetch('https://x.test/c', { browser: 'chrome142', proxyUrl: PROXY });     // same pair → reuse
    await impitFetch('https://x.test/d', { browser: 'chrome142' });                      // direct again → reuse
    expect(f.builds).toEqual([{ browser: 'chrome142' }, { browser: 'chrome142', proxyUrl: PROXY }]);
  });

  it('separates sessions per PROXY as well as per profile (two proxies never share a cookie jar)', async () => {
    const f = recordingFactory();
    const impitFetch = createImpitFetch(f.make);
    await impitFetch('https://x.test/a', { browser: 'chrome142', proxyUrl: PROXY });
    await impitFetch('https://x.test/b', { browser: 'chrome142', proxyUrl: OTHER_PROXY });
    await impitFetch('https://x.test/c', { browser: 'chrome124', proxyUrl: PROXY });
    expect(f.builds).toEqual([
      { browser: 'chrome142', proxyUrl: PROXY },
      { browser: 'chrome142', proxyUrl: OTHER_PROXY },
      { browser: 'chrome124', proxyUrl: PROXY },
    ]);
  });

  it('gives each proxied session its OWN jar: stored cookies are seeded into it, and a prime lands there only', async () => {
    // The proxied session must be self-contained — stored cookies seeded, prime-once discipline intact —
    // and its clearance must not appear in the direct session's jar (separate Impits ⇒ separate jars).
    const seen: Array<{ proxied: boolean; cookie: string }> = [];
    const make = (_browser: string, jar: CookieJarLike, _timeoutMs: number, proxyUrl?: string): ImpitLike => ({
      fetch: async (url) => {
        if (url === 'https://www.anitoysgk.com') { await jar.setCookie('primed=1; Path=/', url); return { text: async () => 'homepage' }; }
        seen.push({ proxied: proxyUrl !== undefined, cookie: String(await jar.getCookieString(url)) });
        return { text: async () => 'ok' };
      },
    });
    const store = {
      cookiesFor: (url: string) => (url.includes('anitoysgk') ? { cf_clearance: 'FAKE_cf_1' } : undefined),
      userAgentFor: () => undefined,
    };
    const impitFetch = createImpitFetch(make, { store });

    const target = 'https://www.anitoysgk.com/lucy-p29358268.html';
    await impitFetch(target, { browser: 'chrome142', proxyUrl: PROXY, prime: { url: 'https://www.anitoysgk.com' } });
    await impitFetch(target, { browser: 'chrome142' }); // the DIRECT session for the same profile

    expect(seen[0]).toEqual({ proxied: true, cookie: expect.stringContaining('cf_clearance=FAKE_cf_1') });
    expect(seen[0].cookie).toContain('primed=1');   // the proxied session's own prime landed in its jar
    expect(seen[1].proxied).toBe(false);
    expect(seen[1].cookie).toContain('cf_clearance=FAKE_cf_1'); // stored cookies seeded into the direct jar too
    expect(seen[1].cookie).not.toContain('primed=1');           // …but NOT the proxied session's prime
  });

  it('the REAL default factory forwards proxyUrl into new Impit({ proxyUrl }) and never enables HTTP/3 (proxies are unsupported with it)', async () => {
    await createImpitFetch()('https://x.test/s', { browser: 'chrome142', proxyUrl: PROXY }); // DEFAULT factory → mocked Impit
    expect(mockImpitCtorOpts).toHaveLength(1);
    expect(mockImpitCtorOpts[0]).toMatchObject({ proxyUrl: PROXY, followRedirects: true });
    expect(mockImpitCtorOpts[0].http3).toBeUndefined();
  });

  it('the REAL default factory omits the proxyUrl key entirely for a direct fetch', async () => {
    await createImpitFetch()('https://x.test/s', { browser: 'chrome142' });
    expect(mockImpitCtorOpts).toHaveLength(1);
    expect(mockImpitCtorOpts[0]).not.toHaveProperty('proxyUrl');
  });
});
