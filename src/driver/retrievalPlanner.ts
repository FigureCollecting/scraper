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

/** A store's targeted query, composed from an IdentityQuery per its capabilities. */
export type ComposedQuery = { kind: 'search'; q: string } | { kind: 'detail'; id: string };

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
 * Compose ONE store's targeted query from a cross-store IdentityQuery, branching on its capabilities:
 *   - `bySearch.acceptsGtin` + a gtin14  → JAN-exact search (amiami/Woo/PrestaShop).
 *   - `byId.idKind === 'barcode'` + a gtin14 → the JAN resolves straight to a detail page (plazajapan).
 *   - else a composed name/ER search where the store has bySearch (Shopify title-index, GK statues).
 *   - else undefined → the store can't serve this identity (→ unsupported).
 */
export function composeStoreQuery(caps: StoreCapabilities, identity: IdentityQuery): ComposedQuery | undefined {
  const r = caps.retrieval;
  if (identity.gtin14 && r?.bySearch?.acceptsGtin) return { kind: 'search', q: identity.gtin14 };
  if (identity.gtin14 && r?.byId?.idKind === 'barcode') return { kind: 'detail', id: identity.gtin14 };
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
    if (url) plans.push({ host: req.host, siteId: caps?.siteId ?? '', url, kind: 'search' });
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
          ...(composed.kind === 'detail' ? { itemId: composed.id } : {}),
        });
      } else unsupported.push(caps.siteId);
    }
    return { plans, unsupported };
  }

  // lookup: fan the query out to every store that supports search
  for (const caps of registry.all()) {
    const url = resolveSearchUrl(caps.retrieval, req.query);
    if (url) plans.push({ host: caps.domains[0], siteId: caps.siteId, url, kind: 'search' });
    else unsupported.push(caps.siteId);
  }
  return { plans, unsupported };
}
