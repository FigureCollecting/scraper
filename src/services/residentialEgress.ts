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
 *   1. The env value is PARSED, never trusted. Only `socks5://`, `socks5h://`, `http://` and
 *      `https://` are usable by every proxying lane we have (impit and Chromium); anything else is
 *      ignored with exactly ONE boot warning that never echoes the value (it may carry credentials).
 *   2. A residential store with no usable proxy is REFUSED — `ResidentialEgressUnavailableError`,
 *      classified by the queue as a non-retried config failure. It must never fall back to the node
 *      IP: that would burn the datacenter path's remaining reputation AND signal that we tried.
 */
import { sanitizeForLog } from '../utils/security.js';

/** Proxy schemes every proxying lane understands (impit: SOCKS5/HTTP; Chromium `--proxy-server`). */
const USABLE_SCHEMES = new Set(['socks5:', 'socks5h:', 'http:', 'https:']);

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
  constructor(url: string, reason: ResidentialEgressRefusal = 'unconfigured') {
    super(
      reason === 'unconfigured'
        ? `Residential egress is declared for ${sanitizeForLog(url)} but RESIDENTIAL_PROXY_URL is not configured — refusing the fetch instead of falling back to the node IP.`
        : `Residential egress is declared for ${sanitizeForLog(url)} but the plain-HTTP lane cannot use a proxy — declare transport 'impersonate' or 'browser' for this store.`,
    );
    this.name = 'ResidentialEgressUnavailableError';
    this.url = url;
    this.reason = reason;
  }
}

/** Parse a proxy URL, returning it only when the scheme is one every proxying lane can use. */
function parseProxy(value: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return USABLE_SCHEMES.has(parsed.protocol) ? parsed : undefined;
}

/**
 * Resolve the residential proxy from the environment. `RESIDENTIAL_PROXY_URL` must parse as a
 * `socks5://` / `socks5h://` / `http://` / `https://` URL; a missing or blank value is simply "no
 * residential egress" (silent — an unfilled manifest field is not a typo), and anything else is
 * IGNORED with one `warn` call that names the variable but never echoes its value (it can carry
 * proxy credentials). Pure (env in → string|undefined out) so it is unit-testable without
 * process.env; the module-level boot resolution below supplies the real console sink.
 */
export function resolveResidentialProxyUrl(
  env: NodeJS.ProcessEnv,
  warn?: (message: string) => void,
): string | undefined {
  const raw = (env.RESIDENTIAL_PROXY_URL ?? '').trim();
  if (raw === '') return undefined;
  if (!parseProxy(raw)) {
    warn?.(
      '[EGRESS] RESIDENTIAL_PROXY_URL is set but is not a usable socks5://, socks5h:// or http(s):// proxy URL — ignoring it; stores declaring egress:\'residential\' will be REFUSED (never sent from the node IP).',
    );
    return undefined;
  }
  return raw;
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

/** Whether a proxy URL is SOCKS — the plain-HTTP lane cannot reach one even with a dispatcher. */
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
  // Deliberately the SAME strictness as the resolver: `user:pass@host` parses as a `user:` URL with
  // an empty host, so a naive `${protocol}//${host}` would echo a fragment of a credential string.
  const parsed = parseProxy(proxyUrl);
  if (!parsed || parsed.host === '') return '<unparseable>';
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

/** The operator view of the residential lane for /health/detailed — credentials always stripped. */
export function residentialEgressView(
  proxyUrl: string | undefined = getResidentialProxyUrl(),
): { configured: boolean; proxy?: string } {
  return proxyUrl ? { configured: true, proxy: redactProxyUrl(proxyUrl) } : { configured: false };
}
