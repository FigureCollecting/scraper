/**
 * retrievalPlanner — turns a targeted-retrieval REQUEST into concrete fetch plans using each
 * store's `RetrievalCapability` templates, as opposed to full-catalog enumeration. Three modes:
 *   - `byId`   — you hold a store's item ids → one detail-fetch plan per id (re-fetch / known ids).
 *   - `search` — you hold a query for one store → one search plan.
 *   - `lookup` — you hold a name/JAN and want it ACROSS stores → a search plan for every store
 *                that supports search (the buy-decision fan-out). Stores that can't serve the
 *                mode come back in `unsupported`, so the caller knows the coverage gap explicitly.
 *
 * Search returns candidates, not final items — the two-stage `search → candidate ids → byId`
 * refinement is the caller's next step (a follow-on increment). Pure and synchronous.
 */
import type { IdentityQuery, RetrievalCapability, StoreCapabilities } from '@figurecollecting/scraper-plugin-contract';
import type { ProfileRegistry } from './profileRegistry.js';

/**
 * A store's targeted query, composed from an IdentityQuery per its capabilities. The `search`
 * variant may carry `filter` tokens (substring-match stores): the store is issued the single most
 * selective identity term as `q`, and every surviving candidate name must contain EVERY `filter`
 * token (applied downstream in assembleLookup). Absent `filter` ⇒ no post-filter (today's behavior).
 */
export type ComposedQuery = { kind: 'search'; q: string; filter?: string[] } | { kind: 'detail'; id: string };

/**
 * Build a name/ER query string from the identity: prefer the display `name` (most likely to match a
 * store's title index), else compose `studio character|series scale` (no-JAN statues / GK). Undefined
 * when there's nothing to search by.
 */
export function composeNameQuery(identity: IdentityQuery): string | undefined {
  if (identity.name?.trim()) return identity.name.trim();
  const parts = [identity.studio, identity.character || identity.series, identity.scale]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * Normalize free text for identity matching: lowercase, punctuation → single spaces, trimmed. Shared
 * by the substring-store filter builder (below) and the candidate post-filter (assembleLookup), so a
 * studio's tokens match inside a decorated title — "star origin studio" ⊂
 * "[Pre-Order] Star Origin Studio 1/6 Cyberpunk: Edgerunners Lucyna Kushinada Statue".
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Identity tokens for substring post-filtering: normalized words, sub-2-char noise dropped. */
export function tokenizeIdentity(s: string): string[] {
  return normalizeText(s).split(' ').filter((t) => t.length >= 2);
}

/** First value that is non-empty after trimming (empty strings are skipped, not only null/undefined). */
const firstNonEmpty = (...vals: (string | undefined)[]): string | undefined => {
  for (const v of vals) {
    const t = (v ?? '').trim();
    if (t) return t;
  }
  return undefined;
};

/**
 * Compose ONE store's targeted query from a cross-store IdentityQuery, branching on its capabilities:
 *   - `bySearch.acceptsGtin` + a gtin14  → JAN-exact search (amiami/Woo/PrestaShop).
 *   - `byId.idKind === 'barcode'` + a gtin14 → the JAN resolves straight to a detail page (plazajapan).
 *   - `bySearch.queryMatch === 'substring'` (Ueeshop/gkloot) → a multi-term phrase matches nothing, so
 *     issue the single most selective identity term (character|series ?? studio ?? name) as `q` and
 *     carry the REST (the studio, when a character/series led) as post-filter tokens.
 *   - else a composed name/ER search where the store has bySearch (Shopify title-index, GK statues).
 *   - else undefined → the store can't serve this identity (→ unsupported).
 */
export function composeStoreQuery(caps: StoreCapabilities, identity: IdentityQuery): ComposedQuery | undefined {
  const r = caps.retrieval;
  if (identity.gtin14 && r?.bySearch?.acceptsGtin) return { kind: 'search', q: identity.gtin14 };
  if (identity.gtin14 && r?.byId?.idKind === 'barcode') return { kind: 'detail', id: identity.gtin14 };
  if (r?.bySearch?.queryMatch === 'substring') {
    const charOrSeries = firstNonEmpty(identity.character, identity.series);
    const studio = firstNonEmpty(identity.studio);
    const primary = charOrSeries ?? studio ?? firstNonEmpty(identity.name);
    if (!primary) return undefined;
    // Post-filter = tokens of the identity components (studio / character|series) that are NOT the
    // primary term — never scale, never name. In practice: the studio, when a character/series led.
    const filter = [charOrSeries, studio]
      .filter((c): c is string => !!c && c !== primary)
      .flatMap((c) => tokenizeIdentity(c));
    return filter.length ? { kind: 'search', q: primary, filter } : { kind: 'search', q: primary };
  }
  const composed = composeNameQuery(identity);
  if (composed && r?.bySearch) return { kind: 'search', q: composed };
  return undefined;
}

/** Build an item detail URL from the byId template, `{id}` url-encoded. */
export function resolveByIdUrl(retrieval: RetrievalCapability | undefined, itemId: string): string | undefined {
  const template = retrieval?.byId?.urlTemplate;
  return template ? template.replace('{id}', encodeURIComponent(itemId)) : undefined;
}

/** Build a search URL from the bySearch template, `{q}` url-encoded. */
export function resolveSearchUrl(retrieval: RetrievalCapability | undefined, query: string): string | undefined {
  const template = retrieval?.bySearch?.urlTemplate;
  return template ? template.replace('{q}', encodeURIComponent(query)) : undefined;
}

export type RetrievalRequest =
  | { mode: 'byId'; host: string; itemIds: string[] }
  | { mode: 'search'; host: string; query: string }
  | { mode: 'lookup'; query: string }
  | { mode: 'record'; identity: IdentityQuery };

export interface FetchPlan {
  host: string;
  siteId: string;
  url: string;
  kind: 'detail' | 'search';
  itemId?: string;
  /** The exact `{q}` issued to this store (search plans) — surfaced as StoreLookupResult.storeQuery. */
  query?: string;
  /** Substring-store post-filter tokens (record-mode): every kept candidate name must contain them all. */
  filter?: string[];
}

export interface RetrievalPlan {
  plans: FetchPlan[];
  /** Store identifiers (siteId, or the host if unknown) that cannot serve the requested mode. */
  unsupported: string[];
}

export function planRetrieval(registry: ProfileRegistry, req: RetrievalRequest): RetrievalPlan {
  const plans: FetchPlan[] = [];
  const unsupported: string[] = [];

  if (req.mode === 'byId') {
    const caps = registry.forHost(req.host);
    for (const itemId of req.itemIds) {
      const url = resolveByIdUrl(caps?.retrieval, itemId);
      if (url) plans.push({ host: req.host, siteId: caps?.siteId ?? '', url, kind: 'detail', itemId });
    }
    if (plans.length === 0) unsupported.push(caps?.siteId ?? req.host);
    return { plans, unsupported };
  }

  if (req.mode === 'search') {
    const caps = registry.forHost(req.host);
    const url = resolveSearchUrl(caps?.retrieval, req.query);
    if (url) plans.push({ host: req.host, siteId: caps?.siteId ?? '', url, kind: 'search', query: req.query });
    else unsupported.push(caps?.siteId ?? req.host);
    return { plans, unsupported };
  }

  if (req.mode === 'record') {
    // record: fan a TYPED identity across every store, composing each store's query server-side
    // (JAN-exact search / barcode-byId detail / composed name search) per its capabilities.
    for (const caps of registry.all()) {
      const composed = composeStoreQuery(caps, req.identity);
      if (!composed) { unsupported.push(caps.siteId); continue; }
      const url = composed.kind === 'search'
        ? resolveSearchUrl(caps.retrieval, composed.q)
        : resolveByIdUrl(caps.retrieval, composed.id);
      if (url) {
        plans.push({
          host: caps.domains[0], siteId: caps.siteId, url, kind: composed.kind === 'search' ? 'search' : 'detail',
          ...(composed.kind === 'detail' ? { itemId: composed.id } : { query: composed.q }),
          ...(composed.kind === 'search' && composed.filter ? { filter: composed.filter } : {}),
        });
      } else unsupported.push(caps.siteId);
    }
    return { plans, unsupported };
  }

  // lookup: fan the query out to every store that supports search
  for (const caps of registry.all()) {
    const url = resolveSearchUrl(caps.retrieval, req.query);
    if (url) plans.push({ host: caps.domains[0], siteId: caps.siteId, url, kind: 'search', query: req.query });
    else unsupported.push(caps.siteId);
  }
  return { plans, unsupported };
}
