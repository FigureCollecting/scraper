/**
 * imageHostPolicy — the operator's table of image hosts, and the lane decision it feeds.
 *
 * An image is rarely served by the page that names it: the store renders on its own domain and the
 * bytes come from a CDN, sometimes one shared by hundreds of stores. So "which lane, which egress"
 * cannot be read off the store's declaration alone, and it is not a per-store guess either — it is
 * OPERATOR configuration, because the answer changes with the CDN's own gate, not with the store's.
 *
 * The decision has two inputs, in this order:
 *   1. the TABLE (`IMAGE_HOST_POLICY_JSON` / `IMAGE_HOST_POLICY_FILE`), matched by longest host
 *      suffix. It overrides everything below it — that is what it is for;
 *   2. the SUFFIX rule the engine already applies to egress (`isDeclaringStoreUrl`): an image on the
 *      DECLARING store's own hosts inherits that store's lane and egress; anything else has the
 *      declared egress DROPPED (`withoutDeclaredEgress`) and takes the plain lane. The residential
 *      exit is a home line: it is never spent on a host that did not declare it.
 *
 * Above both sits the DENY list, which nothing overrides. otakumode.com is permanently banned — not
 * crawled, not fetched, not emitted — so the ban is answered BEFORE the table is consulted at all,
 * and a table entry trying to re-enable it (or to claim one of its subdomains, which would otherwise
 * win the longest-suffix match) changes nothing.
 */
import { readFileSync } from 'node:fs';
import type { SearchFetch } from '@figurecollecting/scraper-plugin-contract';
import { isDeclaringStoreUrl, withoutDeclaredEgress } from '../residentialEgress.js';
import { sanitizeForLog } from '../../utils/security.js';

/** Which bytes lane an image rides. `impit` is the string lane's `impersonate`, under its own name. */
export type ImageLane = 'http' | 'impit' | 'browser';
export type ImageEgress = 'direct' | 'residential';

/** What an operator may say about one image host. Every field is optional; absent ⇒ the rule below. */
export interface ImageHostRule {
  lane?: ImageLane;
  egress?: ImageEgress;
  /** Send the declaring PAGE as `Referer` (hotlink-protected CDNs need it). */
  referer?: boolean;
  ua?: 'chrome' | 'default';
  /** Never fetch this host at all. */
  deny?: boolean;
}

/** The resolved table: the longest-suffix rule for a host, or an empty rule when none matches. */
export interface ImageHostPolicy {
  ruleFor(host: string): ImageHostRule;
}

/** Hosts that are never fetched, no matter what any table says. `tom` is banned permanently. */
export const DENIED_IMAGE_HOSTS: readonly string[] = ['otakumode.com'];

const LANES: readonly string[] = ['http', 'impit', 'browser'];
const EGRESSES: readonly string[] = ['direct', 'residential'];
const UAS: readonly string[] = ['chrome', 'default'];

/**
 * Table key / lookup form of a host: lowercased, trimmed, leading dot and `www.` removed, and the
 * ROOT-ANCHORED trailing dot(s) stripped. That last one is not cosmetic: `otakumode.com.` is the
 * absolute-FQDN spelling of the same host and resolves identically, so without this the permaban —
 * and every operator rule — is evaded by one character. Node's URL parser preserves the dot, and
 * IDN-normalizes the fullwidth `\u3002` into it, so both spellings land here.
 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\./, '').replace(/^www\./, '').replace(/\.+$/, '');
}

/**
 * A URL's hostname in table form; undefined when it does not parse OR is not an http(s) URL. The
 * scheme check is a refusal, not pedantry: `file:`/`data:`/`blob:` have no host to match a rule (or
 * the deny list) against, and undici's fetch would happily serve a `data:` body as if a store had.
 */
function hostOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return normalizeHost(parsed.hostname);
}

/** Build a policy over an already-validated table, with the permaban re-imposed on top. */
export function buildImageHostPolicy(table: Record<string, ImageHostRule>): ImageHostPolicy {
  const rules = new Map<string, ImageHostRule>();
  for (const [host, rule] of Object.entries(table)) rules.set(normalizeHost(host), rule);
  const denied = DENIED_IMAGE_HOSTS.map(normalizeHost);
  return {
    ruleFor(host: string): ImageHostRule {
      const target = normalizeHost(host);
      // The ban is answered BEFORE the table is consulted at all — not merged into it, or a
      // configured entry for a SUBDOMAIN of a banned host (a longer suffix) would outrank it.
      if (denied.some(ban => target === ban || target.endsWith(`.${ban}`))) return { deny: true };
      let best: { key: string; rule: ImageHostRule } | undefined;
      for (const [key, rule] of rules) {
        // Exact host, or a host UNDER it — the dot is load-bearing: `nototakumode.com` merely ends
        // with the banned string and is a different host entirely.
        if (target !== key && !target.endsWith(`.${key}`)) continue;
        if (!best || key.length > best.key.length) best = { key, rule };
      }
      return best ? best.rule : {};
    },
  };
}

/** Validate one entry; unknown or wrongly-typed fields are DROPPED (with a warning), not fatal. */
function validateRule(host: string, raw: unknown, warn: (message: string) => void): ImageHostRule {
  const rule: ImageHostRule = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`[IMAGE-POLICY] entry for ${sanitizeForLog(host)} is not an object — ignoring it.`);
    return rule;
  }
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (field === 'lane' && typeof value === 'string' && LANES.includes(value)) rule.lane = value as ImageLane;
    else if (field === 'egress' && typeof value === 'string' && EGRESSES.includes(value)) rule.egress = value as ImageEgress;
    else if (field === 'ua' && typeof value === 'string' && UAS.includes(value)) rule.ua = value as 'chrome' | 'default';
    else if (field === 'referer' && typeof value === 'boolean') rule.referer = value;
    else if (field === 'deny' && typeof value === 'boolean') rule.deny = value;
    else warn(`[IMAGE-POLICY] ignoring unknown or invalid field '${sanitizeForLog(field)}' on host ${sanitizeForLog(host)}.`);
  }
  return rule;
}

/** Parse a JSON table; `undefined` when it is not a usable `{host: rule}` object (one warning). */
function parseTable(source: string, raw: string, warn: (message: string) => void): Record<string, ImageHostRule> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`[IMAGE-POLICY] ${source} does not parse as JSON (${err instanceof Error ? err.message : String(err)}) — using the default table.`);
    return undefined;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`[IMAGE-POLICY] ${source} is not a { host: rule } object — using the default table.`);
    return undefined;
  }
  const table: Record<string, ImageHostRule> = {};
  for (const [host, rule] of Object.entries(parsed as Record<string, unknown>)) {
    table[host] = validateRule(host, rule, warn);
  }
  return table;
}

/** Injectable IO for {@link loadImageHostPolicy} — tests supply both. */
export interface LoadImageHostPolicyDeps {
  readFile?: (path: string) => string;
  warn?: (message: string) => void;
}

/**
 * Resolve the image host policy from the environment. `IMAGE_HOST_POLICY_JSON` (an inline
 * `{host: rule}` object) is consulted first, then `IMAGE_HOST_POLICY_FILE` (a path to the same
 * shape). An unset, unparseable or unusable value leaves the DEFAULT table — which is the permaban
 * alone — in place, with exactly one warning naming the reason. The ban is never lost.
 */
export function loadImageHostPolicy(
  env: NodeJS.ProcessEnv,
  deps: LoadImageHostPolicyDeps = {},
): ImageHostPolicy {
  // eslint-disable-next-line no-console
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const inline = (env.IMAGE_HOST_POLICY_JSON ?? '').trim();
  if (inline !== '') return buildImageHostPolicy(parseTable('IMAGE_HOST_POLICY_JSON', inline, warn) ?? {});
  const path = (env.IMAGE_HOST_POLICY_FILE ?? '').trim();
  if (path === '') return buildImageHostPolicy({});
  let raw: string;
  try {
    raw = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path);
  } catch (err) {
    warn(`[IMAGE-POLICY] IMAGE_HOST_POLICY_FILE ${sanitizeForLog(path)} could not be read (${err instanceof Error ? err.message : String(err)}) — using the default table.`);
    return buildImageHostPolicy({});
  }
  return buildImageHostPolicy(parseTable(`IMAGE_HOST_POLICY_FILE ${sanitizeForLog(path)}`, raw, warn) ?? {});
}

/** The lane an image is fetched on, or the typed reason it is not fetched at all. */
export type ImageLaneDecision =
  | { ok: true; lane: ImageLane; egress: ImageEgress; referer?: string; ua: 'chrome' | 'default' }
  | { ok: false; reason: 'denied' | 'http-lane-residential'; detail?: string };

/** The store's declared transport under the image lanes' names; undeclared ⇒ browser (ingest default). */
function laneOfTransport(transport: SearchFetch['transport'] | undefined): ImageLane {
  if (transport === 'http') return 'http';
  if (transport === 'impersonate') return 'impit';
  return 'browser';
}

/**
 * Decide how to fetch ONE image. Pure: the same inputs always give the same decision, and nothing is
 * fetched here.
 *
 * `declaringPageUrl` is the store page the image was found on (the egress declaration's owner),
 * `storeLane` that page's declared `searchFetch`. Policy first, then the suffix rule; the plain lane
 * paired with residential egress is refused outright, exactly as the string lane refuses it — Node's
 * fetch cannot proxy, so that pairing has no transport at all.
 */
export function chooseImageLane(
  declaringPageUrl: string,
  imageUrl: string,
  storeLane: SearchFetch | undefined,
  policy: ImageHostPolicy,
): ImageLaneDecision {
  const imageHost = hostOf(imageUrl);
  if (imageHost === undefined) {
    return { ok: false, reason: 'denied', detail: 'the image URL is not a fetchable http(s) URL' };
  }
  const rule = policy.ruleFor(imageHost);
  if (rule.deny) return { ok: false, reason: 'denied', detail: `${sanitizeForLog(imageHost)} is on the image deny list` };

  // The engine's own egress rule, reused rather than restated: on the declaring store's hosts the
  // declaration stands; anywhere else it is stripped of its egress before it is read.
  const onStore = isDeclaringStoreUrl(imageUrl, declaringPageUrl);
  const declared = onStore ? storeLane : withoutDeclaredEgress(storeLane);
  const lane = rule.lane ?? (onStore ? laneOfTransport(declared?.transport) : 'http');
  const egress = rule.egress ?? (declared?.egress === 'residential' ? 'residential' : 'direct');
  if (lane === 'http' && egress === 'residential') {
    return {
      ok: false,
      reason: 'http-lane-residential',
      detail: "the plain-HTTP lane cannot proxy — put this host on 'impit' or 'browser' to fetch it residentially",
    };
  }
  const sendReferer = rule.referer ?? onStore;
  return {
    ok: true,
    lane,
    egress,
    ...(sendReferer ? { referer: declaringPageUrl } : {}),
    ua: rule.ua ?? (lane === 'http' ? 'default' : 'chrome'),
  };
}
