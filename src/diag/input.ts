/**
 * input — the RunProbe input surface (hands-off plan unit S1, design.rpc_input_surface).
 *
 * Everything RunProbe accepts is a request the engine might send upstream, so this refuses, before
 * any budget is touched and with 0 requests, anything outside the declared surface. A refusal names
 * the field; the server (S2) answers it as INVALID_ARGUMENT.
 *
 * The engine registry is INJECTED (DiagInputLookups), so this file names no store and no host.
 *
 * `origin` is the SSRF-sensitive field: the engine runs inside the cluster, so a store-less
 * robots-snapshot may only name a bare DNS hostname over https: a host under an ICANN top-level
 * domain (the Public Suffix List's ICANN section, through tldts), not a public suffix itself, and
 * not a reserved special-use name. That refuses every name outside the ICANN TLDs: most cluster
 * <svc>.<ns> names (scraper.fc, kubernetes.default) and home-network names under private-use
 * suffixes (router.lan, nas.home).
 *
 * This is a check on the NAME only. A name under an ICANN TLD passes wherever it points: a cluster
 * namespace that is also an ICANN TLD (<svc>.data resolves through the pod's ClusterFirst search
 * list), a home router under a delegated TLD (fritz.box), a tailnet name (*.ts.net), and the
 * wildcard-DNS names (127.0.0.1.nip.io, 169.254.169.254.sslip.io, localtest.me). So the dispatch
 * path (S2) must resolve the name itself, as the fully qualified name with a trailing dot so no
 * search list applies; refuse a loopback, private, link-local, CGNAT, unique-local, multicast or
 * unspecified address; connect to the address it checked, on a lane that does not resolve the name
 * again (impit, the browser and the residential SOCKS5 proxy each resolve it themselves); and
 * follow no redirect to a host it has not checked the same way.
 */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';
import { Probe, type RunProbeRequest } from '../gen/fc/diag/v1/diag_pb.js';
import { sanitizeForLog } from '../utils/security.js';
import { probeMaxRequests } from './budget.js';
import { isDnsHostname } from './hostname.js';

/** What the validator needs to know about a registered store. */
export interface DiagStoreInfo {
  readonly siteId: string;
  /** The store's declared byId id pattern, matched against the WHOLE id. Absent = digits only. */
  readonly idPattern?: RegExp;
  /** True when a registered policy denies this store's hosts: the store is refused in every mode. */
  readonly denied?: boolean;
}

/** The registry lookups the validator needs, adapted from the engine registry by the caller. */
export interface DiagInputLookups {
  /** The registered store with this siteId, or undefined. */
  storeById(siteId: string): DiagStoreInfo | undefined;
  /** The siteId of the registered store whose domains cover this host (parent-domain match), or undefined. */
  storeIdForHost(host: string): string | undefined;
  /** True when a registered policy marks this host (or a parent domain) denied. */
  isDeniedHost(host: string): boolean;
}

export type DiagInputField = 'probe' | 'store' | 'origin' | 'ids' | 'pair' | 'run_id';

interface Common {
  /** RunProbeRequest.max_requests, for the budget to cap. Absent = the probe maximum. */
  requested?: number;
  /** Absent = the engine assigns one. */
  runId?: string;
}

export type ValidatedRunProbe =
  | (Common & { probe: Probe.ROBOTS_SNAPSHOT; mode: 'store'; siteId: string })
  | (Common & { probe: Probe.ROBOTS_SNAPSHOT; mode: 'origin'; host: string })
  | (Common & { probe: Probe.ITEM_STATUS; siteId: string; ids: string[]; pair: boolean });

export type DiagInputResult =
  | { ok: true; input: ValidatedRunProbe }
  | { ok: false; field: DiagInputField; reason: string };

/** Longest id accepted, whatever the store's pattern says (the id lands in a url and a log line). */
const MAX_ID_LENGTH = 64;
/** run_id lands in an object key and a log line: a plain token, no separators. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGITS_ONLY = /^[0-9]+$/;
/**
 * Names that are never public DNS: loopback, mDNS, cluster service names, private-use and the
 * RFC 6761 / 7686 special-use names. `cluster.local` is covered by `local`.
 */
const NON_PUBLIC_SUFFIXES = ['localhost', 'local', 'svc', 'internal', 'test', 'example', 'invalid', 'onion', 'arpa'];

function refuse(field: DiagInputField, reason: string): DiagInputResult {
  return { ok: false, field, reason: `${field}: ${reason}` };
}

function quote(value: string): string {
  return `'${sanitizeForLog(value)}'`;
}

/** A copy of `pattern` that must match the whole id, with no lastIndex state and no line anchors. */
function wholeIdMatcher(pattern: RegExp | undefined): RegExp {
  if (pattern === undefined) return DIGITS_ONLY;
  return new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gmy]/g, ''));
}

/** The host and its www. twin: a store or policy registered as www.x also covers x, and x covers www.x. */
function hostVariants(host: string): string[] {
  return [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`];
}

function checkOrigin(raw: string, lookups: DiagInputLookups): { host: string } | DiagInputResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('origin', `${quote(raw)} is not a URL`);
  }
  if (url.protocol !== 'https:') return refuse('origin', `${quote(raw)} must use https`);
  const host = url.hostname;
  if (host.startsWith('[') || isIP(host) !== 0) return refuse('origin', `${quote(host)} is an IP literal`);
  const canonical = `https://${host}`;
  const given = raw.toLowerCase();
  if (given !== canonical && given !== `${canonical}/`) {
    // Only the host's spelling differs (bücher, full-width letters, %-escapes): name the one to give.
    const spelled = /^https:\/\/([^/?#]+)\/?$/.exec(given);
    if (spelled !== null && domainToASCII(spelled[1]) === host) {
      return refuse('origin', `${quote(raw)} must name the host in plain ASCII (xn-- punycode for a non-ASCII name): ${canonical}`);
    }
    return refuse('origin', `${quote(raw)} must be exactly https://<host>: no port, path, query, fragment or userinfo`);
  }
  const labels = host.split('.');
  if (labels.length < 2) return refuse('origin', `${quote(host)} is a single-label name`);
  if (!isDnsHostname(host)) return refuse('origin', `${quote(host)} is not a DNS hostname`);
  const reserved = NON_PUBLIC_SUFFIXES.find((s) => host.endsWith(`.${s}`));
  if (reserved !== undefined) return refuse('origin', `${quote(host)} is not a public name (.${reserved})`);
  // Privately run suffixes (myshopify.com, github.io) are not suffixes here: a shop under one is a
  // host under .com or .io, which is what decides whether the name is public.
  const domain = parseDomain(host, { allowPrivateDomains: false });
  if (domain.isIcann !== true) {
    return refuse('origin', `${quote(host)} is not under an ICANN top-level domain (.${labels[labels.length - 1]})`);
  }
  if (domain.domain === null) return refuse('origin', `${quote(host)} is a public suffix, not a host`);
  const variants = hostVariants(host);
  if (variants.some((h) => lookups.isDeniedHost(h))) {
    return refuse('origin', `${quote(host)} is denied by a registered policy`);
  }
  for (const h of variants) {
    const siteId = lookups.storeIdForHost(h);
    if (siteId !== undefined) {
      return refuse('origin', `${quote(host)} belongs to store ${quote(siteId)}: use --store ${sanitizeForLog(siteId)}`);
    }
  }
  return { host };
}

/**
 * The registered store named `siteId`. A lookup that answers with another store, or a plain-object
 * lookup answering a built-in property (`constructor`, `__proto__`), names no store.
 */
function lookupStore(
  siteId: string,
  lookups: DiagInputLookups
): { store: DiagStoreInfo } | { refusal: DiagInputResult } {
  const store = lookups.storeById(siteId);
  if (store?.siteId !== siteId) return { refusal: refuse('store', `${quote(siteId)} is not a registered store`) };
  if (store.denied === true) return { refusal: refuse('store', `${quote(siteId)} is denied by a registered policy`) };
  return { store };
}

function checkIds(ids: readonly string[], store: DiagStoreInfo): DiagInputResult | undefined {
  const max = probeMaxRequests(Probe.ITEM_STATUS);
  if (ids.length === 0) return refuse('ids', 'item-status needs at least one id');
  if (ids.length > max) return refuse('ids', `at most ${max} ids per call, got ${ids.length}`);
  if (new Set(ids).size !== ids.length) return refuse('ids', 'an id is repeated');
  const matcher = wholeIdMatcher(store.idPattern);
  for (const id of ids) {
    if (id.length > MAX_ID_LENGTH) return refuse('ids', `an id is longer than ${MAX_ID_LENGTH} characters`);
    if (!matcher.test(id)) return refuse('ids', `${quote(id)} is not an id of store ${quote(store.siteId)}`);
  }
  return undefined;
}

/** Validate one RunProbe request against the declared surface and the injected registry. */
export function validateRunProbeInput(req: RunProbeRequest, lookups: DiagInputLookups): DiagInputResult {
  if (req.probe !== Probe.ROBOTS_SNAPSHOT && req.probe !== Probe.ITEM_STATUS) {
    return refuse('probe', `must be ROBOTS_SNAPSHOT or ITEM_STATUS, got ${String(req.probe)}`);
  }
  if (req.runId !== '' && !RUN_ID.test(req.runId)) {
    return refuse('run_id', `${quote(req.runId)} must be letters, digits, '.', '_' or '-', starting with a letter or digit, at most 128`);
  }
  const common: Common = {
    ...(req.maxRequests !== undefined ? { requested: req.maxRequests } : {}),
    ...(req.runId !== '' ? { runId: req.runId } : {}),
  };

  if (req.probe === Probe.ROBOTS_SNAPSHOT) {
    if (req.ids.length > 0) return refuse('ids', 'ids belong to item-status');
    if (req.pair) return refuse('pair', 'pair belongs to item-status');
    if (req.store !== '' && req.origin !== '') return refuse('origin', 'give store or origin, not both');
    if (req.store !== '') {
      const found = lookupStore(req.store, lookups);
      if ('refusal' in found) return found.refusal;
      return { ok: true, input: { probe: Probe.ROBOTS_SNAPSHOT, mode: 'store', siteId: found.store.siteId, ...common } };
    }
    if (req.origin === '') return refuse('store', 'robots-snapshot needs store or origin');
    const origin = checkOrigin(req.origin, lookups);
    if ('ok' in origin) return origin;
    return { ok: true, input: { probe: Probe.ROBOTS_SNAPSHOT, mode: 'origin', host: origin.host, ...common } };
  }

  if (req.origin !== '') return refuse('origin', 'origin belongs to store-less robots-snapshot');
  if (req.store === '') return refuse('store', 'item-status needs store');
  const found = lookupStore(req.store, lookups);
  if ('refusal' in found) return found.refusal;
  const { store } = found;
  const idsRefusal = checkIds(req.ids, store);
  if (idsRefusal !== undefined) return idsRefusal;
  if (req.pair && req.ids.length !== 1) return refuse('pair', 'pair takes exactly one id, the control');
  return { ok: true, input: { probe: Probe.ITEM_STATUS, siteId: store.siteId, ids: [...req.ids], pair: req.pair, ...common } };
}
