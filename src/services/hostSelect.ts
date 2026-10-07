/**
 * hostSelect — the ONE grammar of the per-host scope knobs: SCRAPE_HOST_CLOCK (QB-U30a, extended by
 * QB-U30b) and SCRAPE_POOL_SELECT (QB-U19 reuses this parser; plan-v3 design.pool_select_v1_1.scope).
 *
 *   off | (unset) | (blank)          no host
 *   all                              every host
 *   all,-host[,-host...]             every host except those, INCLUDING hosts first seen after boot:
 *                                    membership is answered per call, never from a boot-time list
 *   host[,host...]                   only those hosts
 *
 * Tokens are comma-separated, trimmed and case-folded; blank tokens are skipped; each host is
 * normalised like the host clock and hostRateLimiter (a trailing dot and a leading `www.` stripped),
 * so `example.com` never pulls in `static.example.com`.
 *
 * MALFORMED values ('-host' without a leading 'all', 'all' mixed with a bare host, '+host', an empty
 * '-' token, an exclusion that is not a bare hostname) log one boot WARN naming the value and select
 * NO host (fail safe = today's behaviour for either knob).
 *
 * One difference between the knobs is kept on purpose: inside a plain host LIST, SCRAPE_HOST_CLOCK
 * (since QB-U30a, its tests pinned) drops a bad entry with a WARN and keeps the rest
 * (`listEntries: 'ignore'`), while SCRAPE_POOL_SELECT treats the whole value as malformed
 * (`listEntries: 'strict'`). The exclusion form is strict for both.
 */

export type HostSelectMode = 'off' | 'all' | 'all-except' | 'hosts';

export interface HostSelect {
  mode: HostSelectMode;
  /** mode 'hosts': the hosts listed (normalised, first spelling wins). */
  hosts: string[];
  /** mode 'all-except': the hosts excluded (normalised). */
  excluded: string[];
  /** One boot WARN line per entry ignored, or one for a malformed value. */
  warnings: string[];
  /** The value was malformed and selects nothing. */
  malformed: boolean;
}

export interface HostSelectGrammar {
  /** The env var named in a WARN. */
  envName: string;
  /** The log tag that starts a WARN, e.g. `[HOST-CLOCK]`. */
  tag: string;
  /** How a bad entry inside a plain host list is handled (see the module doc). */
  listEntries: 'ignore' | 'strict';
}

/** Host key: trimmed, lowercased, trailing root dots and a leading `www.` stripped. */
export function normalizeSelectHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

/** One or more dot-separated labels of letters, digits and inner hyphens: no scheme, path or port. */
const BARE_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Whether an already normalised host is a bare hostname. */
export function isBareHostname(host: string): boolean {
  return BARE_HOSTNAME.test(host);
}

const NOTHING: Omit<HostSelect, 'mode' | 'warnings' | 'malformed'> = { hosts: [], excluded: [] };

/** Parse a scope knob's raw value with the grammar above. */
export function parseHostSelect(raw: string | undefined, grammar: HostSelectGrammar): HostSelect {
  const value = (raw ?? '').trim();
  const tokens = value.split(',').map(token => token.trim()).filter(token => token !== '');
  const malformed = (why: string): HostSelect => ({
    mode: 'off',
    ...NOTHING,
    warnings: [`${grammar.tag} WARN ${grammar.envName}="${value}" is malformed (${why}); treated as off`],
    malformed: true,
  });
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].toLowerCase() === 'off')) {
    return { mode: 'off', ...NOTHING, warnings: [], malformed: false };
  }
  const [first, ...rest] = tokens;
  if (first.toLowerCase() === 'all') {
    if (rest.length === 0) return { mode: 'all', ...NOTHING, warnings: [], malformed: false };
    const exclusions = rest.filter(token => token.startsWith('-'));
    if (exclusions.length > 0) {
      if (exclusions.length !== rest.length) return malformed('"all" mixes -host exclusions with listed hosts');
      const excluded: string[] = [];
      for (const token of exclusions) {
        const host = normalizeSelectHost(token.slice(1));
        if (host === '') return malformed('an empty "-" token');
        if (!isBareHostname(host)) return malformed(`"${token}" does not exclude a bare hostname`);
        if (!excluded.includes(host)) excluded.push(host);
      }
      return { mode: 'all-except', hosts: [], excluded, warnings: [], malformed: false };
    }
    if (grammar.listEntries === 'strict') return malformed('"all" mixed with a listed host');
  }
  const hosts: string[] = [];
  const warnings: string[] = [];
  for (const entry of tokens) {
    const host = normalizeSelectHost(entry);
    let problem: string | undefined;
    if (host === 'off' || host === 'all') problem = 'is a keyword, not a host, inside a host list';
    else if (!isBareHostname(host)) problem = 'is not a bare hostname';
    if (problem === undefined) {
      if (!hosts.includes(host)) hosts.push(host);
      continue;
    }
    if (grammar.listEntries === 'strict') {
      return malformed(entry.startsWith('-') ? `"${entry}" is an exclusion without a leading "all"` : `entry "${entry}" ${problem}`);
    }
    warnings.push(`${grammar.tag} WARN ${grammar.envName} entry "${entry}" ${problem}; ignored`);
  }
  return { mode: hosts.length === 0 ? 'off' : 'hosts', hosts, excluded: [], warnings, malformed: false };
}

/** Whether a parsed scope selects `host` (normalised here), answered per call. */
export function hostSelected(select: HostSelect, host: string): boolean {
  const key = normalizeSelectHost(host);
  switch (select.mode) {
    case 'all':
      return true;
    case 'all-except':
      return !select.excluded.includes(key);
    case 'hosts':
      return select.hosts.includes(key);
    default:
      return false;
  }
}
