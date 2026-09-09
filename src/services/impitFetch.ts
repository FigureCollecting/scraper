/**
 * impitFetch — a browser-TLS-impersonating HTTP GET (via impit) that clears Cloudflare's
 * fingerprint gate WITHOUT launching a real browser. The light counterpart to
 * ScrapingService.browserFetch, for CF-fronted JSON APIs (e.g. amiami's search endpoint) — ~600ms
 * vs the browser's tens of seconds. impit is loaded LAZILY (dynamic import inside the default
 * factory) so unit tests and non-impersonate code paths never touch the native binary. One Impit
 * instance — WITH a per-profile cookie jar — is cached per impersonation profile.
 */
import type { FetchBodyDetail } from './engineServices/capturingFetch.js';
import { CookieJar } from 'tough-cookie';
import { isCloudflareChallenge } from './engineServices/challengeDetect.js';
import { getCfCookieStore, type CfCookieSource } from './cookieJar.js';
import { normalizeHost } from './challengeCooldown.js';

/** Default impersonation profile. A LIVE TUNABLE — chrome110 already went stale to Cloudflare; keep recent. */
export const DEFAULT_PROFILE = 'chrome142';

/** Per-request timeout (ms) used when IMPIT_TIMEOUT_MS is unset/invalid, and the clamp any override rides within. */
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 120000;

/**
 * Resolve the per-request impit timeout (ms) from the environment. IMPIT_TIMEOUT_MS overrides the
 * 30s default; a missing, empty, non-numeric, or non-positive value falls back to that default, and
 * any usable value is clamped to [5000, 120000] so a typo can neither strangle nor unbound a slow
 * session-gated store's prime + target GETs (the Impit budgets each GET separately). Pure
 * (env in → number out) so it is unit-testable without touching process.env.
 */
export function resolveImpitTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.IMPIT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n));
}

/** Per-request timeout applied to every impit GET (prime and target alike). Resolved ONCE at module load. */
const TIMEOUT_MS = resolveImpitTimeoutMs(process.env);
/**
 * How long a host's prime is trusted before it is re-primed. Cloudflare's cf_clearance is short-lived
 * (~30 min); kept safely under that so a primed host whose clearance has expired is re-primed instead
 * of being pinned to a dead session for the process lifetime. A challenge that returns BEFORE the TTL
 * lapses is caught separately by challenge-detection re-prime (see impitFetchBody below).
 */
const PRIME_TTL_MS = 20 * 60 * 1000;

/**
 * The impit RESPONSE surface we depend on. `text()` is the only member every impit build is
 * guaranteed to have and the only one the string lanes use. The rest are OPTIONAL and
 * feature-detected by the image BYTES lane: `bytes()`/`arrayBuffer()` are the binary capability
 * (without one, an image cannot be fetched on this lane at all — decoding it through `text()` would
 * corrupt it, so the lane returns a typed 'unsupported' instead), and `status`/`headers`/`url` are
 * read defensively when present. Declaring them optional keeps every existing fake — a bare
 * `{ text() }` — assignable, so nothing on the string path changes.
 */
export interface ImpitResponseLike {
  text(): Promise<string>;
  /** Binary body (impit's fetch-shaped response). Preferred by the image bytes lane. */
  bytes?(): Promise<Uint8Array>;
  /** Binary body, the WHATWG spelling — used when `bytes()` is absent. */
  arrayBuffer?(): Promise<ArrayBuffer>;
  readonly status?: number;
  /** A `Headers`-like bag (`get(name)`) or a plain record; read defensively, never assumed. */
  readonly headers?: unknown;
  /** The URL the body came from, after redirects. */
  readonly url?: string;
}

/** Minimal impit surface we depend on — lets tests inject a fake without the native module. */
export interface ImpitLike {
  fetch(url: string, init: { method: string; headers?: Record<string, string> }): Promise<ImpitResponseLike>;
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
  /**
   * RESIDENTIAL EGRESS: route this fetch through the given proxy (`socks5://` / `http(s)://`) —
   * threaded into the Impit itself, since impit takes the proxy per SESSION, not per request. The
   * session cache is therefore keyed by (profile, proxy) so a proxied session never shares its
   * cookie jar with the direct one (a clearance minted from the residential IP must not be replayed
   * from the node IP, nor the reverse). Absent ⇒ the direct session (byte-identical).
   */
  proxyUrl?: string;
}

/**
 * Build a real impit instance for a profile — dynamic-imported so the native binary loads only on use.
 * The per-profile cookie jar is threaded in so cf_clearance from the prime GET persists onto the
 * target fetch (impit is stateless without a jar).
 */
export async function defaultMakeImpit(
  browser: string,
  cookieJar: CookieJarLike,
  timeoutMs: number,
  proxyUrl?: string,
): Promise<ImpitLike> {
  const { Impit } = await import('impit');
  // `browser` is a runtime-valid profile string; impit types it as a Browser enum. `cookieJar` is a
  // tough-cookie CookieJar — the store impit's JS binding reads/writes for cross-request cookies.
  // `proxyUrl` (residential egress) is a SESSION property in impit, so it is set here and the
  // session cache is keyed by it. HTTP/3 is never enabled: impit cannot use a proxy with it on.
  return new Impit({
    browser: browser as never,
    followRedirects: true,
    timeout: timeoutMs,
    cookieJar: cookieJar as never,
    ...(proxyUrl ? { proxyUrl } : {}),
  }) as unknown as ImpitLike;
}

/** Per-profile cookie jar (tough-cookie) — impit stores prime cookies here and sends them on later GETs. */
function defaultMakeCookieJar(): CookieJarLike {
  return new CookieJar() as unknown as CookieJarLike;
}

export type MakeImpit = (browser: string, cookieJar: CookieJarLike, timeoutMs: number, proxyUrl?: string) => ImpitLike | Promise<ImpitLike>;

/**
 * One cached Impit plus its session-prime bookkeeping. The Impit is per impersonation profile and
 * owns a per-profile cookie jar (its cf_clearance persists across calls); `primed` maps each already-
 * primed host to the timestamp of its prime (for TTL expiry), and `priming` holds the single in-flight
 * prime promise per host so concurrent first-fetches share ONE prime instead of racing.
 */
interface ImpitSession {
  impit: ImpitLike;
  /** The per-profile jar impit reads/writes — kept so stored cookies can be SEEDED into it per call. */
  jar: CookieJarLike;
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
  // Delegate to the shared, conservative detector (engineServices/challengeDetect) rather than keep
  // a second copy of the markers; 'Just a moment' (loose) and 'cf-mitigated' remain impit's own
  // extra triggers so this stays a strict SUPERSET of the shared detector — never narrower —
  // preserving the pre-existing re-prime sensitivity.
  return isCloudflareChallenge(body) || body.includes('Just a moment') || body.includes('cf-mitigated');
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

/**
 * Seed the session jar with a host's STORED cookies (CfCookieStore) before a fetch: one tough-cookie
 * setCookie per cookie, domain-scoped to the url's www-stripped host (`Domain=.host; Path=/`, plus
 * `Secure` on https — a Secure cookie set from an http origin is stored but never sent). Runs on EVERY
 * call: cheap, idempotent, and it deliberately OVERWRITES any server-rotated value with the file's
 * (CF cannot be re-solved from the pod's IP, so the hand-minted value is the only one that can work).
 * A cookie the jar rejects is skipped with one warn naming the cookie NAME only — never a value.
 */
export async function seedJar(jar: CookieJarLike, url: string, cookies: Record<string, string>): Promise<void> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return;
  }
  const host = normalizeHost(target.hostname);
  const attrs = `; Domain=.${host}; Path=/${target.protocol === 'https:' ? '; Secure' : ''}`;
  for (const [name, value] of Object.entries(cookies)) {
    try {
      await jar.setCookie(`${name}=${value}${attrs}`, `${target.origin}/`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[CF-COOKIE] could not seed stored cookie ${name} for ${host} into the impit jar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
  /** Stored-cookie source (defaults to the CfCookieStore singleton, resolved per call). */
  store?: CfCookieSource;
}

/**
 * Read one impit response into the status-aware detail shape. `status` and `url` are OPTIONAL
 * members of {@link ImpitResponseLike} (not every build exposes them, and no fake has to), so each
 * is carried only when it is really there — an absent status is honest, a fabricated 200 is not.
 */
async function readDetail(res: ImpitResponseLike): Promise<FetchBodyDetail> {
  const body = await res.text();
  return {
    body,
    ...(typeof res.status === 'number' ? { status: res.status } : {}),
    ...(typeof res.url === 'string' && res.url !== '' ? { finalUrl: res.url } : {}),
  };
}

/**
 * Build the STATUS-AWARE impit fetcher: the same request, the same prime/re-prime discipline, but
 * answering `{ body, status?, finalUrl? }` so the ingest path can tell what the store said from what
 * our ruleset could not lift. On the re-prime path it is the SECOND (post-clearance) response that
 * is reported — the one whose body the caller receives.
 *
 * `makeImpit` is injectable (tests pass a fake); the default lazily loads the native impit and
 * threads a per-profile tough-cookie jar into it.
 */
export function createImpitFetchDetailed(makeImpit: MakeImpit = defaultMakeImpit, options: CreateImpitFetchOptions = {}) {
  const now = options.now ?? Date.now;
  const primeTtlMs = options.primeTtlMs ?? PRIME_TTL_MS;
  // Cache the SESSION promise (not the resolved session) so the get-then-set is synchronous and two
  // concurrent first-calls for a profile can never build two Impits. A failed build evicts itself.
  const sessions = new Map<string, Promise<ImpitSession>>();
  function getSession(browser: string, proxyUrl?: string): Promise<ImpitSession> {
    // The cache key pairs the impersonation profile with the EGRESS: a proxied and a direct session
    // must be distinct Impits (hence distinct cookie jars and prime bookkeeping), because a
    // Cloudflare clearance is bound to the IP it was minted from.
    const key = `${browser}\u0000${proxyUrl ?? 'direct'}`;
    let sp = sessions.get(key);
    if (!sp) {
      sp = (async (): Promise<ImpitSession> => {
        const jar = defaultMakeCookieJar();
        const impit = await makeImpit(browser, jar, TIMEOUT_MS, proxyUrl);
        return { impit, jar, primed: new Map<string, number>(), priming: new Map<string, Promise<void>>() };
      })();
      sessions.set(key, sp);
      sp.catch(() => {
        if (sessions.get(key) === sp) sessions.delete(key);
      });
    }
    return sp;
  }
  return async function impitFetchDetail(url: string, opts: ImpitFetchOptions = {}): Promise<FetchBodyDetail> {
    const browser = opts.browser || DEFAULT_PROFILE;
    const session = await getSession(browser, opts.proxyUrl);
    // STORED COOKIES + PINNED UA (CfCookieStore): seed the host's hand-minted cookies into the jar
    // before the prime/target GETs, and let the mint User-Agent win over the caller's and the
    // profile's — cf_clearance is bound to IP + UA, so any other UA voids it. Unknown host ⇒ nothing
    // seeded and no pin: byte-identical to the pre-store path.
    const store = options.store ?? getCfCookieStore();
    const stored = store.cookiesFor(url);
    if (stored) await seedJar(session.jar, url, stored);
    const pinnedUa = store.userAgentFor(url);
    const headers: Record<string, string> = {
      ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}),
      ...(opts.headers ?? {}),
      ...(pinnedUa ? { 'User-Agent': pinnedUa } : {}),
    };
    if (!opts.prime) {
      return readDetail(await session.impit.fetch(url, { method: 'GET', headers }));
    }
    const primeUrl = opts.prime.url;
    await ensurePrimed(session, primeUrl, headers, now(), primeTtlMs);
    let detail = await readDetail(await session.impit.fetch(url, { method: 'GET', headers }));
    // Only a parseable prime host can be re-primed; an unparseable one has nothing to retry against,
    // so it returns the body as-is rather than re-fetching the target for no gain.
    if (hostOf(primeUrl) !== undefined && looksLikeChallenge(detail.body)) {
      // Primed host still challenged ⇒ the clearance expired within its TTL, or CF rotated the
      // challenge. Invalidate and re-prime ONCE (bounded — no loop), then retry the target. Still
      // challenged ⇒ return it; the ruleset yields empty and the caller's own retry/backoff owns the
      // next attempt.
      invalidatePrime(session, primeUrl);
      await ensurePrimed(session, primeUrl, headers, now(), primeTtlMs);
      detail = await readDetail(await session.impit.fetch(url, { method: 'GET', headers }));
    }
    return detail;
  };
}

/**
 * Build BOTH impit surfaces over ONE session cache: `detailed` for the ingest path (which needs the
 * response's status) and `body` for the lookup's fetchSearch dispatcher, /resolve and the plugins'
 * own follow-up fetches (which consume `(url, opts?) => Promise<string>`).
 *
 * THE SESSION MUST BE SHARED. An Impit session owns a cookie jar and a prime ledger, and a
 * Cloudflare clearance is bound to the session that minted it — so two factories mean two jars, two
 * prime ledgers and a SECOND homepage prime per TTL on every session-gated host. Each of those is a
 * real request spending the estate's scarcest resource, the egress IP's reputation, for a clearance
 * the process already held.
 */
export function createImpitFetchers(makeImpit: MakeImpit = defaultMakeImpit, options: CreateImpitFetchOptions = {}) {
  const detailed = createImpitFetchDetailed(makeImpit, options);
  return {
    detailed,
    body: async function impitFetchBody(url: string, opts: ImpitFetchOptions = {}): Promise<string> {
      return (await detailed(url, opts)).body;
    },
  };
}

/**
 * Build a standalone impit BODY fetcher. Its OWN session — use {@link createImpitFetchers} when a
 * caller needs both surfaces, or the two will prime the same gated host twice.
 */
export function createImpitFetch(makeImpit: MakeImpit = defaultMakeImpit, options: CreateImpitFetchOptions = {}) {
  return createImpitFetchers(makeImpit, options).body;
}

/** The engine's default impit session — ONE per process, shared by both exports below. */
const defaultImpitFetchers = createImpitFetchers();

/** The engine's default status-aware impit fetcher (the ingest path's impersonate lane). */
export const impitFetchBodyDetailed = defaultImpitFetchers.detailed;

/** The engine's default impit fetcher (real native impit, per-profile cookie jar, chrome142 default profile). */
export const impitFetchBody = defaultImpitFetchers.body;
