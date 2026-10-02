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
 * robots-snapshot may only name a bare public DNS hostname over https. This is a check on the NAME;
 * a public name that resolves to a private address is a matter for the dispatch path.
 */
import { isIP } from 'node:net';
import { Probe, type RunProbeRequest } from '../gen/fc/diag/v1/diag_pb.js';
import { sanitizeForLog } from '../utils/security.js';
import { probeMaxRequests } from './budget.js';

/** What the validator needs to know about a registered store. */
export interface DiagStoreInfo {
  readonly siteId: string;
  /** The store's declared byId id pattern, matched against the WHOLE id. Absent = digits only. */
  readonly idPattern?: RegExp;
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
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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
  const canonical = `https://${host}`;
  const given = raw.toLowerCase();
  if (given !== canonical && given !== `${canonical}/`) {
    return refuse('origin', `${quote(raw)} must be exactly https://<host>: no port, path, query, fragment or userinfo`);
  }
  if (host.startsWith('[') || isIP(host) !== 0) return refuse('origin', `${quote(host)} is an IP literal`);
  const labels = host.split('.');
  if (labels.length < 2) return refuse('origin', `${quote(host)} is a single-label name`);
  if (host.length > 253 || !labels.every((l) => DNS_LABEL.test(l))) {
    return refuse('origin', `${quote(host)} is not a DNS hostname`);
  }
  const reserved = NON_PUBLIC_SUFFIXES.find((s) => host.endsWith(`.${s}`));
  if (reserved !== undefined) return refuse('origin', `${quote(host)} is not a public name (.${reserved})`);
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
      if (lookups.storeById(req.store) === undefined) return refuse('store', `${quote(req.store)} is not a registered store`);
      return { ok: true, input: { probe: Probe.ROBOTS_SNAPSHOT, mode: 'store', siteId: req.store, ...common } };
    }
    if (req.origin === '') return refuse('store', 'robots-snapshot needs store or origin');
    const origin = checkOrigin(req.origin, lookups);
    if ('ok' in origin) return origin;
    return { ok: true, input: { probe: Probe.ROBOTS_SNAPSHOT, mode: 'origin', host: origin.host, ...common } };
  }

  if (req.origin !== '') return refuse('origin', 'origin belongs to store-less robots-snapshot');
  if (req.store === '') return refuse('store', 'item-status needs store');
  const store = lookups.storeById(req.store);
  if (store === undefined) return refuse('store', `${quote(req.store)} is not a registered store`);
  const idsRefusal = checkIds(req.ids, store);
  if (idsRefusal !== undefined) return idsRefusal;
  if (req.pair && req.ids.length !== 1) return refuse('pair', 'pair takes exactly one id, the control');
  return { ok: true, input: { probe: Probe.ITEM_STATUS, siteId: req.store, ids: [...req.ids], pair: req.pair, ...common } };
}
