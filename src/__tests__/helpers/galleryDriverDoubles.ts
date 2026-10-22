/**
 * Test doubles for the gallery driver's unit tests (rounds 2 and 3): a hook with the real hook's memo semantics, a sink whose counters a
 * test moves from inside `flush`, a ledger that remembers HOW each pair was settled.
 */
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import type { ImageBytesResult } from '../../services/images/imageBytes';
import {
  createFetchObserver, createMemoryLedger,
  type ConfirmingSink, type GalleryLedger, type GalleryRunOptions, type Settled,
} from '../../services/images/galleryDriver';
import type { WorklistItem } from '../../services/images/galleryWorklist';

export const STATIC = 'static.myfigurecollection.net';
export const U = (n: number | string) => `https://${STATIC}/upload/pictures/2022/10/14/${n}.jpeg`;
export const PAGE = (id: string) => `https://myfigurecollection.net/item/${id}`;
export const PNG = (n: number, size = 11) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n]), Buffer.alloc(Math.max(0, size - 11))]);
export const POLICY = buildImageHostPolicy({ [STATIC]: { lane: 'http', egress: 'direct' } });
export const noop = () => undefined;
export const K = (id: string) => `mfc/${id}`;

export const item = (id: string, nums: number[], over: Partial<WorklistItem> = {}): WorklistItem => ({
  site: 'mfc', itemId: id, pageUrl: PAGE(id), rank: 0, entries: nums.map((n, i) => ({ position: i, src: U(n), w: 600, h: 600 })), ...over,
});
export async function* feed(items: WorklistItem[]) { for (const it of items) yield { ok: true as const, item: it, dropped: 0 }; }
export const ok200 = (n = 1, size = 11): ImageBytesResult => ({ ok: true, bytes: PNG(n, size), contentType: 'image/png', status: 200, finalUrl: 'x', headers: {} });
export const baseOpts = (over: Partial<GalleryRunOptions> = {}): GalleryRunOptions => ({ allowedHosts: [STATIC], pauseAfter: 3, pauseMs: 6 * 3600_000, ...over });

export type Counters = { assetFailed: number; dropped: number; droppedBytes: number; assetRefusedReserve: number; assetSkipped: { tooLarge: number; notImage: number; empty: number; disabled: number } };
export const zero = (): Counters => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0, assetSkipped: { tooLarge: 0, notImage: 0, empty: 0, disabled: 0 } });
/** A sink whose counters the test moves from inside `flush`, as a worker finishing (or failing) a put does. */
export const scriptedSink = (onFlush: (n: number, c: Counters) => void): ConfirmingSink => {
  const c = zero();
  let n = 0;
  return { flush: async () => { onFlush(++n, c); }, stats: () => ({ ...c, assetSkipped: { ...c.assetSkipped } }) };
};

/**
 * A hook double with the real hook's memo semantics: a url fetched once is a MEMO hit for any later item (no request, a `memo` skip);
 * `forget` makes it fetch again. Remembering happens at admission, before the sink has put anything, as the real hook does.
 */
export function memoHook(observer: ReturnType<typeof createFetchObserver>, script: (url: string) => ImageBytesResult = () => ok200(), opts: { preseeded?: string[]; noForget?: boolean; extraSkip?: (itemId: string) => string | undefined } = {}) {
  const remembered = new Set<string>(opts.preseeded ?? []);
  const forgotten: string[][] = [];
  const fetchedUrls: string[] = [];
  const skipped: Record<string, number> = { memo: 0, cap: 0, sinkQueueFull: 0, refused: 0 };
  const fetcher = observer.wrap(async url => script(url));
  const hook = {
    async capture(req: { itemId: string; ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
      const extra = opts.extraSkip?.(req.itemId);
      if (extra !== undefined) skipped[extra] = (skipped[extra] ?? 0) + 1;
      for (const r of req.ruleset.describeImages!(req.fields)) {
        if (remembered.has(r.url)) { skipped.memo += 1; continue; }
        fetchedUrls.push(r.url);
        const res = await fetcher(r.url, {});
        if (res.ok) remembered.add(r.url);
      }
    },
    stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: { ...skipped } }),
    ...(opts.noForget === true ? {} : { forget(urls: readonly string[]) { forgotten.push([...urls]); for (const u of urls) remembered.delete(u); } }),
  };
  return { hook: hook as never, forgotten, fetchedUrls };
}

/** A ledger that remembers HOW each pair was settled. */
export function recordingLedger(): { ledger: GalleryLedger; how: Map<string, Settled> } {
  const inner = createMemoryLedger();
  const how = new Map<string, Settled>();
  return { how, ledger: { ...inner, has: inner.has, settle(i, u, h) { how.set(`${i} ${u.split('/').pop()}`, h); inner.settle(i, u, h); } } };
}
export const gdeps = (hook: never, sink: ConfirmingSink, observer: ReturnType<typeof createFetchObserver>, ledger: GalleryLedger, items: WorklistItem[]) =>
  ({ hook, sink, observer, policy: POLICY, ledger, items: feed(items), now: () => 0, log: noop, requests: () => [] });

