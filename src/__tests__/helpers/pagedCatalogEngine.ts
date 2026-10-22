/**
 * Test helper (QB-U24) — a fake ENGINE serving a paged, newest-first catalog listing per store, for the
 * crawler's backfill page-pool tests and their knob-off golden.
 *
 * GET /catalog?store=&page=p answers page p of the store's CURRENT item list: `pageSize` ids per page,
 * `hasMore` while ids remain below the page, and an exhausted page (no items, hasMore false) past the end.
 * A single-page store (mfc's Latest Additions feed, maxPages 1) answers every page above 1 exhausted.
 * Ids can be PREPENDED between passes (listing drift: new items push every item down). Every POST
 * /ingest/scrape is accepted unless `ingest` says otherwise. Every request is recorded; nothing here
 * reaches a real host.
 */
import type { FetchLike, HttpResponseLike } from '../../crawler/crawler';

export interface PagedStoreSpec {
  /** Ids per listing page. */
  pageSize: number;
  /** The listing, newest first. */
  items: string[];
  /** Every page above 1 answers exhausted (a single-page feed). */
  singlePage?: boolean;
}

export interface EngineCall {
  method: 'GET' | 'POST';
  store: string;
  /** The listing page of a GET. */
  page?: number;
  /** `GET /catalog?...` (scraper base stripped) or `POST <collectUrl>`. */
  line: string;
}

export interface EngineReply {
  status: number;
  body?: unknown;
}

export const itemUrl = (siteId: string, id: string): string => `https://${siteId}.test/item/${id}`;

/** `count` ids `${prefix}${start}`, `${prefix}${start - 1}`, ... (newest first). */
export const idRun = (prefix: string, start: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${start - i}`);

export const makePagedEngine = (
  specs: Record<string, PagedStoreSpec>,
  opts: {
    /** Replaces a listing GET's normal answer (a cooldown, say); undefined = the normal answer. */
    reply?: (store: string, page: number) => EngineReply | undefined;
    /** Replaces an ingest POST's normal 202; undefined = accepted. */
    ingest?: (url: string) => EngineReply | undefined;
  } = {},
) => {
  const stores = new Map(Object.entries(specs).map(([k, v]) => [k, { ...v, items: [...v.items] }]));
  const calls: EngineCall[] = [];
  const resp = (status: number, body: unknown): HttpResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const listing = (siteId: string, page: number): EngineReply => {
    const s = stores.get(siteId);
    if (!s) return { status: 422, body: { error: 'unsupported', siteId, reason: 'unknown store' } };
    const url = `https://${siteId}.test/list?page=${page}`;
    const from = (page - 1) * s.pageSize;
    const ids = s.singlePage && page > 1 ? [] : s.items.slice(from, from + s.pageSize);
    const hasMore = !s.singlePage && from + s.pageSize < s.items.length;
    return {
      status: 200,
      body: {
        siteId,
        page,
        url,
        items: ids.map((id) => ({ itemId: id, collectUrl: itemUrl(siteId, id) })),
        collectUrls: ids.map((id) => itemUrl(siteId, id)),
        hasMore,
        ...(hasMore ? { nextPage: page + 1 } : {}),
        count: ids.length,
      },
    };
  };

  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET') as 'GET' | 'POST';
    if (method === 'POST') {
      const posted = (JSON.parse(init?.body ?? '{}') as { url: string }).url;
      const store = new URL(posted).hostname.replace(/\.test$/, '');
      calls.push({ method, store, line: `POST ${posted}` });
      const r = opts.ingest?.(posted) ?? { status: 202, body: { success: true, deduplicated: false, position: 1 } };
      return resp(r.status, r.body ?? {});
    }
    const u = new URL(url);
    const store = u.searchParams.get('store') ?? '';
    const page = Number(u.searchParams.get('page'));
    calls.push({ method, store, page, line: `GET ${u.pathname}${u.search}` });
    const r = opts.reply?.(store, page) ?? listing(store, page);
    return resp(r.status, r.body ?? {});
  };

  return {
    fetch,
    calls,
    /** New items arrive at the top of a store's listing (newest first), pushing every item down. */
    prepend: (siteId: string, ids: string[]): void => {
      const s = stores.get(siteId)!;
      s.items = [...ids, ...s.items];
    },
    items: (siteId: string): string[] => [...stores.get(siteId)!.items],
    /** Listing pages GET in dispatch order (one store, or all). */
    pages: (siteId?: string): number[] =>
      calls.filter((c) => c.method === 'GET' && (!siteId || c.store === siteId)).map((c) => c.page as number),
    /** POSTed collect urls in order. */
    posted: (siteId?: string): string[] =>
      calls.filter((c) => c.method === 'POST' && (!siteId || c.store === siteId)).map((c) => c.line.slice(5)),
  };
};

/** A fake clock that the gate's spacing sleep advances. */
export const fakeClock = (start: number) => {
  let t = start;
  return {
    now: (): number => t,
    set: (ms: number): void => {
      t = ms;
    },
    sleep: async (ms: number): Promise<void> => {
      t += ms;
    },
  };
};
