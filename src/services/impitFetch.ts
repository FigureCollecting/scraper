/**
 * impitFetch — a browser-TLS-impersonating HTTP GET (via impit) that clears Cloudflare's
 * fingerprint gate WITHOUT launching a real browser. The light counterpart to
 * ScrapingService.browserFetch, for CF-fronted JSON APIs (e.g. amiami's search endpoint) — ~600ms
 * vs the browser's tens of seconds. impit is loaded LAZILY (dynamic import inside the default
 * factory) so unit tests and non-impersonate code paths never touch the native binary. One Impit
 * instance is cached per impersonation profile.
 */

/** Default impersonation profile. A LIVE TUNABLE — chrome110 already went stale to Cloudflare; keep recent. */
const DEFAULT_PROFILE = 'chrome142';
const TIMEOUT_MS = 15000;

/** Minimal impit surface we depend on — lets tests inject a fake without the native module. */
export interface ImpitLike {
  fetch(url: string, init: { method: string; headers?: Record<string, string> }): Promise<{ text(): Promise<string> }>;
}

export interface ImpitFetchOptions {
  /** Impersonation profile (impit browser), e.g. 'chrome142'. Defaults to a recent engine value. */
  browser?: string;
  headers?: Record<string, string>;
  userAgent?: string;
  /**
   * Session-prime target for a session-gated store. When set, the SAME cached Impit first GETs
   * `prime.url` ONCE per (profile, host) session — establishing the Cloudflare clearance cookie in
   * the impit cookie jar — before the target fetch. Idempotent (prime-once-per-host-per-session) and
   * concurrency-safe (a single in-flight prime per host; concurrent first-fetches never double-prime).
   * Absent ⇒ no prime (byte-identical to the pre-prime behavior).
   */
  prime?: { url: string };
}

/** Build a real impit instance for a profile — dynamic-imported so the native binary loads only on use. */
async function defaultMakeImpit(browser: string): Promise<ImpitLike> {
  const { Impit } = await import('impit');
  // `browser` is a runtime-valid profile string; impit types it as a Browser enum.
  return new Impit({ browser: browser as never, followRedirects: true, timeout: TIMEOUT_MS }) as unknown as ImpitLike;
}

export type MakeImpit = (browser: string) => ImpitLike | Promise<ImpitLike>;

/**
 * One cached Impit plus its session-prime bookkeeping. The Impit is per impersonation profile (its
 * cookie jar persists across calls); `primed` records which hosts have already had their homepage
 * prime GET this session, and `priming` holds the single in-flight prime promise per host so
 * concurrent first-fetches share ONE prime instead of racing.
 */
interface ImpitSession {
  impit: ImpitLike;
  primed: Set<string>;
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
 * Prime a host ONCE per session: GET the prime URL on the session's Impit so the clearance cookie
 * lands in its jar. Concurrency-safe — the check-then-set of `priming` has no `await` between them,
 * so two concurrent callers to a fresh host share the one in-flight prime; on completion the entry
 * is cleared so a later session (or a failed prime) can re-prime. The prime response body is read
 * and DISCARDED here — it is never returned to a caller and so never reaches the capture sink
 * (capture neutrality: a prime is not a product capture).
 */
function ensurePrimed(session: ImpitSession, primeUrl: string, headers: Record<string, string>): Promise<void> {
  const host = hostOf(primeUrl);
  if (host === undefined) return Promise.resolve();
  if (session.primed.has(host)) return Promise.resolve();
  const inFlight = session.priming.get(host);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      await session.impit.fetch(primeUrl, { method: 'GET', headers });
      session.primed.add(host);
    } finally {
      session.priming.delete(host);
    }
  })();
  session.priming.set(host, p);
  return p;
}

/**
 * Build an impit body-fetcher. `makeImpit` is injectable (tests pass a fake); the default lazily
 * loads the native impit. Returns `(url, opts?) => Promise<string>` — the same shape the lookup's
 * fetchSearch dispatcher consumes. A `prime` option triggers a same-session homepage prime for
 * session-gated stores (see {@link ImpitFetchOptions.prime}); absent, behavior is byte-identical.
 */
export function createImpitFetch(makeImpit: MakeImpit = defaultMakeImpit) {
  // Cache the SESSION promise (not the resolved session) so the get-then-set is synchronous and two
  // concurrent first-calls for a profile can never build two Impits. A failed build evicts itself.
  const sessions = new Map<string, Promise<ImpitSession>>();
  function getSession(browser: string): Promise<ImpitSession> {
    let sp = sessions.get(browser);
    if (!sp) {
      sp = (async (): Promise<ImpitSession> => {
        const impit = await makeImpit(browser);
        return { impit, primed: new Set<string>(), priming: new Map<string, Promise<void>>() };
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
    if (opts.prime) {
      await ensurePrimed(session, opts.prime.url, headers);
    }
    const res = await session.impit.fetch(url, { method: 'GET', headers });
    return res.text();
  };
}

/** The engine's default impit fetcher (real native impit, chrome142 default profile). */
export const impitFetchBody = createImpitFetch();
