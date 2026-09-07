/**
 * residentialEgress — the engine's RESIDENTIAL egress configuration and its typed refusal.
 *
 * A handful of Cloudflare-fronted stores (the anitoys / surugaya / sugotoys / hobby-genki / MFC
 * cohort) gate on IP/ASN REPUTATION rather than on browser fingerprint: the same TLS-impersonating
 * client that is challenged from the datacenter node gets a plain 200 from a residential IP, and
 * their challenge-passage windows are far shorter than a hand-minted cookie can survive. The
 * deployment answers that with a userspace SOCKS5 proxy in-cluster whose exit node is a residential
 * line; a store opts in by declaring `searchFetch.egress: 'residential'` (contract 0.7.0) and the
 * engine routes only THAT store's fetches through the proxy named by `RESIDENTIAL_PROXY_URL`.
 *
 * Two invariants live here:
 *   1. The env value is PARSED, never trusted, and is only accepted in a shape EVERY proxying lane
 *      can actually use — the NARROWEST of the lanes, which is Chromium's `--proxy-server`:
 *      `socks5://host:port` or `http(s)://host:port`, with NO embedded credentials. Chromium
 *      rejects anything else outright (`net::ERR_NO_SUPPORTED_PROXIES`, probed against this repo's
 *      own Chromium 2026-09-07) while impit accepts it happily — so a wider rule would produce a
 *      half-working cohort: impit fetches succeed, every browser fetch dies with an opaque
 *      Chromium error. `socks5h://` (curl's "resolve DNS at the proxy" spelling) is CANONICALIZED
 *      to `socks5://`, which is precisely what Chromium's socks5 already does; anything else is
 *      ignored with exactly ONE boot warning that never echoes the value (it may carry credentials).
 *   2. A residential store with no usable proxy is REFUSED — `ResidentialEgressUnavailableError`,
 *      classified by the queue as a non-retried config failure. It must never fall back to the node
 *      IP: that would burn the datacenter path's remaining reputation AND signal that we tried.
 */
import type { SearchFetch, WaitForReadiness } from '@figurecollecting/scraper-plugin-contract';
import { sanitizeForLog } from '../utils/security.js';
import { resolvePrime } from './sessionPrime.js';

/**
 * Proxy schemes every proxying lane understands. impit also speaks socks4 and takes credentials;
 * Chromium takes NEITHER, and a value only one lane can use is worse than no value at all — see
 * invariant 1. `socks5h:` is accepted at the door but canonicalized away (never handed to a lane).
 */
const USABLE_SCHEMES = new Set(['socks5:', 'http:', 'https:']);

/** Why a residential fetch was refused. */
export type ResidentialEgressRefusal = 'unconfigured' | 'unsupported-lane';

/**
 * A store declared `egress: 'residential'` but the fetch cannot be made through a residential path —
 * either no usable `RESIDENTIAL_PROXY_URL` is configured (`unconfigured`), or the lane the store
 * declared cannot reach the configured proxy at all (`unsupported-lane`: the plain-HTTP lane, whose
 * global `fetch` has no proxy support). Both are CONFIG shortfalls, not transient faults: the queue
 * classifies this class as `extraction_unavailable` (never retried, never a cookie/auth fault), so a
 * misconfigured store fails fast and loudly instead of quietly leaking onto the node IP.
 */
export class ResidentialEgressUnavailableError extends Error {
  readonly url: string;
  readonly reason: ResidentialEgressRefusal;
  constructor(url: string, reason: ResidentialEgressRefusal = 'unconfigured', detail?: string) {
    super(
      reason === 'unconfigured'
        ? `Residential egress is declared for ${sanitizeForLog(url)} but RESIDENTIAL_PROXY_URL is not configured — refusing the fetch instead of falling back to the node IP.`
        : `Residential egress is declared for ${sanitizeForLog(url)} but the plain-HTTP lane cannot use a proxy${detail ? ` (${detail})` : ''} — declare transport 'impersonate' or 'browser' for this store.`,
    );
    this.name = 'ResidentialEgressUnavailableError';
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Parse a proxy URL into the canonical, lane-portable form — or `undefined` when no lane could use
 * it. `socks5h://` collapses to `socks5://` (same semantics: DNS resolved proxy-side, which is what
 * Chromium's socks5 does), and an embedded `user:password` is a hard reject rather than something to
 * strip: Chromium's `--proxy-server` cannot carry credentials and this engine has no proxy-auth path
 * (nothing calls `page.authenticate`), so accepting them would leave the browser lane dead.
 */
function parseProxy(value: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (hasCredentials(parsed)) return undefined;
  const protocol = parsed.protocol === 'socks5h:' ? 'socks5:' : parsed.protocol;
  // A host-less value ('socks5://', 'http:///path') parses happily but names no proxy to dial, so
  // it is as unusable as a bad scheme — and far more confusing downstream, since it would reach the
  // lanes looking like a configured proxy.
  if (!USABLE_SCHEMES.has(protocol) || parsed.host === '') return undefined;
  return new URL(`${protocol}//${parsed.host}`);
}

/** Whether a parsed URL carries a userinfo component (either half is enough to break Chromium). */
function hasCredentials(parsed: URL): boolean {
  return parsed.username !== '' || parsed.password !== '';
}

/**
 * Why a value was unusable, as a phrase for the ONE boot warning — never echoing the value itself,
 * which may be a credentialed URL. Parsed leniently so a credentialed proxy is named as such (the
 * operator's actual mistake) instead of being lumped in with "bad scheme".
 */
function unusableReason(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'it does not parse as a URL';
  }
  if (hasCredentials(parsed)) {
    return "it embeds proxy credentials, which Chromium's --proxy-server cannot carry (the browser lane would fail every fetch with ERR_NO_SUPPORTED_PROXIES) — use a credential-free proxy endpoint";
  }
  if (parsed.host === '') return 'it names no proxy host';
  return "its scheme is not one every lane can use (socks5:// or socks5h:// — both sent as socks5 — http:// or https://)";
}

/**
 * Resolve the residential proxy from the environment, in the CANONICAL `scheme://host:port` form
 * every lane accepts (`socks5h://` folded to `socks5://`). `RESIDENTIAL_PROXY_URL` must parse as a
 * credential-free `socks5(h)://` / `http://` / `https://` URL; a missing or blank value is simply
 * "no residential egress" (silent — an unfilled manifest field is not a typo), and anything else is
 * IGNORED with one `warn` call that names the variable and the reason but never echoes its value
 * (it can carry proxy credentials). Pure (env in → string|undefined out) so it is unit-testable
 * without process.env; the module-level boot resolution below supplies the real console sink.
 */
export function resolveResidentialProxyUrl(
  env: NodeJS.ProcessEnv,
  warn?: (message: string) => void,
): string | undefined {
  const raw = (env.RESIDENTIAL_PROXY_URL ?? '').trim();
  if (raw === '') return undefined;
  const parsed = parseProxy(raw);
  if (!parsed) {
    warn?.(
      `[EGRESS] RESIDENTIAL_PROXY_URL is set but ${unusableReason(raw)} — ignoring it; stores declaring egress:'residential' will be REFUSED (never sent from the node IP).`,
    );
    return undefined;
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * The residential proxy for this process, resolved ONCE at module load (mirrors IMPIT_TIMEOUT_MS):
 * one boot warning for a garbage value, never one per fetch.
 */
const BOOT_PROXY_URL = resolveResidentialProxyUrl(process.env, (message) => {
  // eslint-disable-next-line no-console
  console.warn(message);
});

/** The process's configured residential proxy (undefined ⇒ residential stores are refused). */
export function getResidentialProxyUrl(): string | undefined {
  return BOOT_PROXY_URL;
}

/**
 * Whether a proxy URL is SOCKS — the plain-HTTP lane cannot reach one even with a dispatcher.
 * Parsed with the resolver's own strictness (so `socks5h://` counts, a credentialed URL does not),
 * which is exact for its only caller: the value the resolver already produced.
 */
export function isSocksProxy(proxyUrl: string): boolean {
  const parsed = parseProxy(proxyUrl);
  return parsed !== undefined && (parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:');
}

/**
 * `scheme://host:port` — a proxy string safe to publish (health endpoint, logs): any embedded
 * `user:password` is dropped. An unparseable value degrades to a fixed placeholder rather than
 * being echoed.
 */
export function redactProxyUrl(proxyUrl: string): string {
  // Deliberately LENIENT where the resolver is strict: the resolver only ever yields a canonical,
  // credential-free proxy, but redaction is the last line of defence for any value that reaches a
  // log or the health endpoint, so it strips userinfo from shapes the resolver would have refused
  // too. The empty-host guard matters: `user:pass@host` parses as a `user:` URL with an EMPTY host,
  // so a naive `${protocol}//${host}` would echo a fragment of a credential string.
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return '<unparseable>';
  }
  if (parsed.host === '') return '<unparseable>';
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * The per-fetch egress decision. `undefined` for an undeclared/`direct` store (nothing changes for
 * every store that predates 0.7.0); the proxy URL for a residential store; a typed REFUSAL for a
 * residential store with no configured proxy — the one branch that must never degrade quietly.
 */
export function requireResidentialProxy(
  url: string,
  egress: 'direct' | 'residential' | undefined,
  proxyUrl: string | undefined,
): string | undefined {
  if (egress !== 'residential') return undefined;
  if (!proxyUrl) throw new ResidentialEgressUnavailableError(url, 'unconfigured');
  return proxyUrl;
}

/** A URL's hostname, lowercased and `www.`-stripped; `undefined` when it does not parse. */
function egressHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Whether `url` belongs to the store that DECLARED the egress (`declaringUrl` = the store URL the
 * declaration was resolved for). The residential exit is the HOME line: a store declaring it opts
 * ITSELF in, not every host a ruleset happens to name in a follow-up. Without this, a ruleset
 * fetching an image CDN or a third-party API through `ctx.scraping` would hand the home IP to a host
 * that never declared it and spend that line's reputation on unrelated traffic.
 *
 * The store's own subdomains count (an asset host under the declaring domain); a look-alike that
 * merely ENDS with the same string does not (the dot in the suffix test is load-bearing). Compared
 * against the declaring host rather than an eTLD+1, so no public-suffix list is needed — which also
 * avoids the `.com.au` trap that a naive "last two labels" rule falls into (sugotoys.com.au).
 */
export function isDeclaringStoreUrl(url: string, declaringUrl: string): boolean {
  const target = egressHost(url);
  const declaring = egressHost(declaringUrl);
  if (target === undefined || declaring === undefined) return false;
  return target === declaring || target.endsWith(`.${declaring}`);
}

/** The same declaration with its egress dropped — what an OFF-STORE follow-up is dispatched with. */
export function withoutDeclaredEgress(searchFetch: SearchFetch | undefined): SearchFetch | undefined {
  if (!searchFetch?.egress) return searchFetch;
  const { egress: _declared, ...rest } = searchFetch;
  return rest;
}

/** The browser lane's per-request wiring resolved from a store's declared `searchFetch`. */
export interface BrowserLaneEgressOptions {
  /** Residential proxy to bind this request's incognito context to. */
  proxyServer?: string;
  /** Client-rendered readiness the store declared (`waitFor`), carried alongside the egress. */
  waitFor?: WaitForReadiness;
  /** The store declares a Cloudflare gate (`access: 'cloudflare'`): keep this host's context alive. */
  challengeGated?: boolean;
  /** Session prime (`sessionPrime`) resolved to the URL a FRESH browser context visits first. */
  primeUrl?: string;
}

/**
 * Resolve the browser lane's per-request options for a store — the ONE place every browser-lane
 * caller outside the search dispatchers (the /resolve primary detail fetch, and the ExtractContext
 * `scrapePage`/`scrapePageStealth` passthroughs a ruleset navigates through) turns a declared
 * `searchFetch` into wiring:
 *   - `egress: 'residential'` + a configured proxy ⇒ `proxyServer` (the request's context is bound
 *     to the residential exit);
 *   - `egress: 'residential'` + NO proxy ⇒ the typed refusal, thrown here so the caller never
 *     reaches the network from the node IP;
 *   - undeclared / `direct` and no `waitFor` ⇒ `undefined`, so the caller can invoke the lane
 *     exactly as it did before 0.7.0 (byte-identical for every pre-existing store).
 */
export function resolveBrowserLaneOptions(
  url: string,
  searchFetch: SearchFetch | undefined,
  proxyUrl: string | undefined,
): BrowserLaneEgressOptions | undefined {
  const proxyServer = requireResidentialProxy(url, searchFetch?.egress, proxyUrl);
  // A CHALLENGE-GATED store also carries its session prime onto the browser lane: a fresh context
  // is a cold session, and a cold session at anitoys 404s its own search results.
  const challengeGated = searchFetch?.access === 'cloudflare';
  const prime = challengeGated ? resolvePrime(searchFetch, url) : undefined;
  const options: BrowserLaneEgressOptions = {
    ...(proxyServer ? { proxyServer } : {}),
    ...(searchFetch?.waitFor ? { waitFor: searchFetch.waitFor } : {}),
    ...(challengeGated ? { challengeGated: true } : {}),
    ...(prime ? { primeUrl: prime.url } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * The operator view of the residential lane for /health/detailed.
 *
 * `configured` answers the operator's actual question ("is residential egress wired?"). The proxy's
 * `scheme://host:port` is NOT published by default: /health/detailed is unauthenticated, and the
 * exact egress endpoint is topology nobody needs from outside the pod. Set
 * `RESIDENTIAL_EGRESS_HEALTH_DETAIL=true` to include it (credentials are stripped either way — this
 * view is the last line of defence for a value that reaches a log or a response).
 */
export function residentialEgressView(
  proxyUrl: string | undefined = getResidentialProxyUrl(),
  env: NodeJS.ProcessEnv = process.env,
): { configured: boolean; proxy?: string } {
  if (!proxyUrl) return { configured: false };
  if (env.RESIDENTIAL_EGRESS_HEALTH_DETAIL !== 'true') return { configured: true };
  return { configured: true, proxy: redactProxyUrl(proxyUrl) };
}

/**
 * The PLAIN-HTTP lane's residential rule: it cannot honour residential egress, so it REFUSES.
 *
 * Node's global `fetch` has no proxy support of its own — proxying it needs an undici dispatcher —
 * and undici's `ProxyAgent` speaks only HTTP(S) proxies, never SOCKS, which is exactly what the
 * cluster's userspace Tailscale egress proxy is. Rather than half-support one scheme, the lane
 * refuses both and says so: a store that needs residential egress belongs on `impersonate` (impit
 * takes `proxyUrl` natively, SOCKS5 included) or on `browser` (Chromium's per-context
 * `proxyServer`). The refusal is the same typed class as an unconfigured proxy, so it is booked as
 * a non-retried config failure — never a silent fetch from the node IP.
 */
export function refuseHttpLaneResidentialEgress(url: string, proxyUrl: string): never {
  throw new ResidentialEgressUnavailableError(
    url,
    'unsupported-lane',
    isSocksProxy(proxyUrl)
      ? 'the configured proxy is SOCKS, which an undici ProxyAgent cannot speak'
      : "Node's global fetch has no proxy support on this lane",
  );
}
