/**
 * impitFetch — a browser-TLS-impersonating HTTP GET (via impit) that clears Cloudflare's
 * fingerprint gate WITHOUT launching a real browser. The light counterpart to
 * ScrapingService.browserFetch, for CF-fronted JSON APIs (e.g. amiami's search endpoint) — ~600ms
 * vs the browser's tens of seconds. impit is loaded LAZILY (dynamic import inside the default
 * factory) so unit tests and non-impersonate code paths never touch the native binary. One Impit
 * instance — WITH a per-profile cookie jar — is cached per impersonation profile.
 */
import { CookieJar } from 'tough-cookie';

/** Default impersonation profile. A LIVE TUNABLE — chrome110 already went stale to Cloudflare; keep recent. */
const DEFAULT_PROFILE = 'chrome142';
const TIMEOUT_MS = 15000;
/**
 * How long a host's prime is trusted before it is re-primed. Cloudflare's cf_clearance is short-lived
 * (~30 min); kept safely under that so a primed host whose clearance has expired is re-primed instead
 * of being pinned to a dead session for the process lifetime. A challenge that returns BEFORE the TTL
 * lapses is caught separately by challenge-detection re-prime (see impitFetchBody below).
 */
const PRIME_TTL_MS = 20 * 60 * 1000;

/** Minimal impit surface we depend on — lets tests inject a fake without the native module. */
export interface ImpitLike {
  fetch(url: string, init: { method: string; headers?: Record<string, string> }): Promise<{ text(): Promise<string> }>;
}

/**
 * Minimal cookie-jar surface impit drives (a structural subset of tough-cookie's CookieJar). Threaded
 * per profile into the Impit so the prime GET's `Set-Cookie: cf_clearance=…` is STORED and then SENT
 * on the target fetch. WITHOUT a jar impit 0.14.3 is stateless — it stores/sends no cookies across
 * requests — so priming could never carry clearance and every primed target stayed a cold challenge.
 */
export interface CookieJarLike {
  setCookie(cookie: string, url: string, ...rest: unknown[]): Promise<unknown> | unknown;
  getCookieString(url: string, ...rest: unknown[]): Promise<string> | string;
}

export interface ImpitFetchOptions {
  /** Impersonation profile (impit browser), e.g. 'chrome142'. Defaults to a recent engine value. */
  browser?: string;
  headers?: Record<string, string>;
  userAgent?: string;
  /**
   * Session-prime target for a session-gated store. When set, the SAME cached Impit first GETs
   * `prime.url` ONCE per (profile, host) session — landing the Cloudflare clearance cookie in the
   * Impit's cookie jar so the target fetch SENDS it. Idempotent (prime-once-per-host-per-session,
   * re-primed once its TTL lapses or a fresh challenge returns) and concurrency-safe (a single
   * in-flight prime per host; concurrent first-fetches never double-prime).
   * Absent ⇒ no prime (byte-identical to the pre-prime behavior).
   */
  prime?: { url: string };
}

/**
 * Build a real impit instance for a profile — dynamic-imported so the native binary loads only on use.
 * The per-profile cookie jar is threaded in so cf_clearance from the prime GET persists onto the
 * target fetch (impit is stateless without a jar).
 */
async function defaultMakeImpit(browser: string, cookieJar: CookieJarLike): Promise<ImpitLike> {
  const { Impit } = await import('impit');
  // `browser` is a runtime-valid profile string; impit types it as a Browser enum. `cookieJar` is a
  // tough-cookie CookieJar — the store impit's JS binding reads/writes for cross-request cookies.
  return new Impit({
    browser: browser as never,
    followRedirects: true,
    timeout: TIMEOUT_MS,
    cookieJar: cookieJar as never,
  }) as unknown as ImpitLike;
}

/** Per-profile cookie jar (tough-cookie) — impit stores prime cookies here and sends them on later GETs. */
function defaultMakeCookieJar(): CookieJarLike {
  return new CookieJar() as unknown as CookieJarLike;
}

export type MakeImpit = (browser: string, cookieJar: CookieJarLike) => ImpitLike | Promise<ImpitLike>;

/**
 * One cached Impit plus its session-prime bookkeeping. The Impit is per impersonation profile and
 * owns a per-profile cookie jar (its cf_clearance persists across calls); `primed` maps each already-
 * primed host to the timestamp of its prime (for TTL expiry), and `priming` holds the single in-flight
 * prime promise per host so concurrent first-fetches share ONE prime instead of racing.
 */
interface ImpitSession {
  impit: ImpitLike;
  primed: Map<string, number>;
  priming: Map<string, Promise<void>>;
}

/** Host key for the primed/priming maps — undefined on an unparseable URL (then priming is skipped). */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Whether a response body is a Cloudflare interstitial challenge rather than real content. Narrow by
 * design (matches the CF managed-challenge markers, not incidental copy) so a real page/JSON is never
 * misread as a challenge: at worst a false positive costs one wasted re-prime + refetch, never a loop.
 */
function looksLikeChallenge(body: string): boolean {
  return (
    body.includes('Just a moment') ||
    body.includes('/cdn-cgi/challenge-platform/') ||
    body.includes('cf-mitigated')
  );
}

/**
 * Prime a host ONCE per session (until its TTL lapses): GET the prime URL on the session's Impit so
 * the clearance cookie lands in its jar. Concurrency-safe — the check-then-set of `priming` has no
 * `await` between them, so two concurrent callers to a fresh host share the one in-flight prime; on
 * completion the entry is cleared so a later session (expired TTL, invalidated, or a failed prime) can
 * re-prime. The prime response body is read and DISCARDED here — it is never returned to a caller and
 * so never reaches the capture sink (capture neutrality: a prime is not a product capture).
 */
function ensurePrimed(
  session: ImpitSession,
  primeUrl: string,
  headers: Record<string, string>,
  nowMs: number,
  ttlMs: number,
): Promise<void> {
  const host = hostOf(primeUrl);
  if (host === undefined) return Promise.resolve();
  const primedAt = session.primed.get(host);
  if (primedAt !== undefined && nowMs - primedAt < ttlMs) return Promise.resolve();
  const inFlight = session.priming.get(host);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      await session.impit.fetch(primeUrl, { method: 'GET', headers });
      session.primed.set(host, nowMs);
    } finally {
      session.priming.delete(host);
    }
  })();
  session.priming.set(host, p);
  return p;
}

/** Drop a host's primed marker so the next fetch re-primes it (used when its clearance has gone stale). */
function invalidatePrime(session: ImpitSession, primeUrl: string): void {
  const host = hostOf(primeUrl);
  if (host !== undefined) session.primed.delete(host);
}

/** Tunables for {@link createImpitFetch} — injectable so tests drive TTL expiry deterministically. */
export interface CreateImpitFetchOptions {
  /** Clock source (defaults to Date.now); tests inject a controllable clock to exercise TTL expiry. */
  now?: () => number;
  /** How long a prime is trusted before re-priming (defaults to {@link PRIME_TTL_MS}). */
  primeTtlMs?: number;
}

/**
 * Build an impit body-fetcher. `makeImpit` is injectable (tests pass a fake); the default lazily
 * loads the native impit and threads a per-profile tough-cookie jar into it. Returns
 * `(url, opts?) => Promise<string>` — the same shape the lookup's fetchSearch dispatcher consumes. A
 * `prime` option triggers a same-session homepage prime for session-gated stores (see
 * {@link ImpitFetchOptions.prime}); absent, behavior is byte-identical to the pre-prime path.
 */
export function createImpitFetch(makeImpit: MakeImpit = defaultMakeImpit, options: CreateImpitFetchOptions = {}) {
  const now = options.now ?? Date.now;
  const primeTtlMs = options.primeTtlMs ?? PRIME_TTL_MS;
  // Cache the SESSION promise (not the resolved session) so the get-then-set is synchronous and two
  // concurrent first-calls for a profile can never build two Impits. A failed build evicts itself.
  const sessions = new Map<string, Promise<ImpitSession>>();
  function getSession(browser: string): Promise<ImpitSession> {
    let sp = sessions.get(browser);
    if (!sp) {
      sp = (async (): Promise<ImpitSession> => {
        const jar = defaultMakeCookieJar();
        const impit = await makeImpit(browser, jar);
        return { impit, primed: new Map<string, number>(), priming: new Map<string, Promise<void>>() };
      })();
      sessions.set(browser, sp);
      sp.catch(() => {
        if (sessions.get(browser) === sp) sessions.delete(browser);
      });
    }
    return sp;
  }
  return async function impitFetchBody(url: string, opts: ImpitFetchOptions = {}): Promise<string> {
    const browser = opts.browser || DEFAULT_PROFILE;
    const session = await getSession(browser);
    const headers: Record<string, string> = {
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      ...(opts.headers ?? {}),
    };
    if (!opts.prime) {
      const res = await session.impit.fetch(url, { method: 'GET', headers });
      return res.text();
    }
    const primeUrl = opts.prime.url;
    await ensurePrimed(session, primeUrl, headers, now(), primeTtlMs);
    let body = await (await session.impit.fetch(url, { method: 'GET', headers })).text();
    // Only a parseable prime host can be re-primed; an unparseable one has nothing to retry against,
    // so it returns the body as-is rather than re-fetching the target for no gain.
    if (hostOf(primeUrl) !== undefined && looksLikeChallenge(body)) {
      // Primed host still challenged ⇒ the clearance expired within its TTL, or CF rotated the
      // challenge. Invalidate and re-prime ONCE (bounded — no loop), then retry the target. Still
      // challenged ⇒ return it; the ruleset yields empty and the caller's own retry/backoff owns the
      // next attempt.
      invalidatePrime(session, primeUrl);
      await ensurePrimed(session, primeUrl, headers, now(), primeTtlMs);
      body = await (await session.impit.fetch(url, { method: 'GET', headers })).text();
    }
    return body;
  };
}

/** The engine's default impit fetcher (real native impit, per-profile cookie jar, chrome142 default profile). */
export const impitFetchBody = createImpitFetch();
