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
import type { RetrievalCapability } from '@figurecollecting/scraper-plugin-contract';
import type { ProfileRegistry } from './profileRegistry.js';

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
  | { mode: 'lookup'; query: string };

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

  // lookup: fan the query out to every store that supports search
  for (const caps of registry.all()) {
    const url = resolveSearchUrl(caps.retrieval, req.query);
    if (url) plans.push({ host: caps.domains[0], siteId: caps.siteId, url, kind: 'search' });
    else unsupported.push(caps.siteId);
  }
  return { plans, unsupported };
}
