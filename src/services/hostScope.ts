/**
 * HOST-SCOPE GRAMMAR for per-host knobs (QB-U19, review 4 SHOULD 3 / R3-N5). SCRAPE_POOL_SELECT reads it;
 * QB-U30b reuses it for SCRAPE_HOST_CLOCK.
 *
 *   off | <empty>              off: no host
 *   all                        every host
 *   all,-h1[,-h2...]           every host except h1, h2 ... INCLUDING hosts first seen after boot:
 *                              membership is answered per call, never from a boot-time host list
 *   h1[,h2...]                 only those hosts
 *
 * Tokens are comma-separated, trimmed and case-folded; every host is normalised like the host clock
 * (trimmed, lowercased, trailing dots and a leading `www.` stripped), the knob's spelling and the asked
 * host's alike, so `-WWW.Store.Example.` excludes `store.example` however a URL spells it.
 * A host must be a bare hostname (labels of letters, digits and inner hyphens: no scheme, port or path).
 *
 * Anything else is MALFORMED: `-host` without a leading `all`, `all` mixed with a bare host, `+host`, an
 * empty `-` token, an empty token (`a,,b`, a trailing comma), `off` or `all` inside a list, a repeated
 * `all`, a token that is not a bare host. A malformed value is treated as OFF (fail safe: today's
 * behaviour) and yields one warning naming the value, for the caller to log once at boot.
 */
import { sanitizeForLog } from '../utils/security.js';

export type HostScopeKind = 'off' | 'all' | 'all-except' | 'hosts';

/** 'in': covered. 'excluded': named by an `all,-host` exclusion. 'out': not covered (off, or not listed). */
export type HostMembership = 'in' | 'excluded' | 'out';

export interface HostScope {
  readonly kind: HostScopeKind;
  /** The listed hosts (kind 'hosts') or the excluded ones (kind 'all-except'), normalised, first spelling order. */
  readonly hosts: readonly string[];
  readonly malformed: boolean;
  /** One line naming the env var and the raw value when malformed, else null. */
  readonly warning: string | null;
  membership(host: string): HostMembership;
}

/** Host key: trimmed, lowercased, trailing root dots and a leading `www.` stripped (the host clock's rule). */
export function normalizeScopeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** One or more dot-separated labels of letters, digits and inner hyphens: no scheme, path or port. */
const BARE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The normalised host when `token` names a bare hostname, else null. */
export function bareScopeHost(token: string): string | null {
  const host = normalizeScopeHost(token);
  return BARE_HOSTNAME.test(host) ? host : null;
}

function scope(kind: HostScopeKind, hosts: string[]): HostScope {
  const set = new Set(hosts);
  const membership = (host: string): HostMembership => {
    if (kind === 'off') return 'out';
    if (kind === 'all') return 'in';
    const key = normalizeScopeHost(host);
    if (kind === 'all-except') return set.has(key) ? 'excluded' : 'in';
    return set.has(key) ? 'in' : 'out';
  };
  return { kind, hosts, malformed: false, warning: null, membership };
}

function malformed(raw: string, envName: string, why: string): HostScope {
  return {
    kind: 'off',
    hosts: [],
    malformed: true,
    warning: `WARN ${envName}="${sanitizeForLog(raw)}" is malformed (${sanitizeForLog(why)}); treated as off`,
    membership: () => 'out',
  };
}

/** Read a host-scope knob's raw value. Never throws; a malformed value is off with a warning. */
export function parseHostScope(raw: string | undefined, envName: string): HostScope {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'off') return scope('off', []);
  const tokens = value.split(',').map((t) => t.trim().toLowerCase());
  if (tokens.some((t) => t === '')) return malformed(value, envName, 'an empty entry');
  if (tokens[0] === 'all') {
    const excluded: string[] = [];
    for (const token of tokens.slice(1)) {
      if (!token.startsWith('-')) return malformed(value, envName, `'${token}' after 'all' is not a '-host' exclusion`);
      const host = bareScopeHost(token.slice(1));
      if (host === null) return malformed(value, envName, `'${token}' does not exclude a bare hostname`);
      if (!excluded.includes(host)) excluded.push(host);
    }
    return scope(excluded.length === 0 ? 'all' : 'all-except', excluded);
  }
  const listed: string[] = [];
  for (const token of tokens) {
    if (token === 'all' || token === 'off') return malformed(value, envName, `'${token}' is a keyword inside a host list`);
    if (token.startsWith('-')) return malformed(value, envName, `'${token}' excludes a host without a leading 'all'`);
    const host = bareScopeHost(token);
    if (host === null) return malformed(value, envName, `'${token}' is not a bare hostname`);
    if (!listed.includes(host)) listed.push(host);
  }
  return scope('hosts', listed);
}
