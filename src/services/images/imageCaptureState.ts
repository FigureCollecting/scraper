/**
 * imageCaptureState — the two things the image hook has to REMEMBER between items.
 *
 * Both exist to stop a fetch nobody asked for, at two different scales:
 *
 *   - the MEMO answers "have I already got this?" for one image. An item page is re-scraped on every
 *     pass, and its gallery does not change between them; without a memo, capture would re-download
 *     the same dozen files every time the item is revisited, for a bucket that is content-addressed
 *     and therefore already holds them. The object store's own HEAD would catch it, but only AFTER
 *     the bytes crossed the wire — which is the expensive half.
 *   - the BUDGET answers "how much has the home line carried today?". The residential exit is a
 *     domestic connection, and a store gated behind it will happily serve gigabytes of plates. The
 *     ceiling is on the LINE, not on any one store, because that is what the line is.
 *
 * Both are process-local by design: they are an optimization and a courtesy, never a correctness
 * boundary. A restart forgets, re-fetches a little, and the store dedups it — nothing is lost.
 */

/**
 * What the winner's sink actually PUT, remembered so a later item that shares the url can report its
 * OWN depiction against the SAME stored object. The storage key and byte length are the two facts the
 * bucket knows and the memo hit does not (it skipped the fetch), and `fetchedAt` lets the memo-hit
 * report dedup into the winner's ONE `raw.capture` row instead of manufacturing a second observation
 * for a fetch that never happened.
 */
export interface StoredAsset {
  /** Lowercase hex sha256 — the content address. */
  sha256: string;
  /** The object key the winner wrote (raw-img/sha256/<aa>/<hex>.<ext>). */
  storageKey: string;
  /** Uncompressed byte length of the stored original. */
  bytesLen: number;
  /** The winner's fetched-at token — the capture key, re-sent so a memo hit dedups rather than forks. */
  fetchedAt: string;
  /**
   * The RESOLVED address the winner reported under (finalUrl ?? url). A memo hit is keyed by the
   * REQUEST url, but the report must name the same resolved url the winner's capture used, or a
   * redirect would fork a second raw.capture for the same blob.
   */
  url: string;
  contentType?: string;
}

/** A url→content memo with a bound on what it will hold. */
export interface ImageUrlMemo {
  /** Whether this exact url has already been fetched and handed on. */
  hasUrl(url: string): boolean;
  /** Whether these exact BYTES have already been handed on, under any url. */
  hasSha(sha256: string): boolean;
  /** The sha this url resolved to, or undefined — what a memo-hit report names as its content address. */
  shaFor(url: string): string | undefined;
  /**
   * The winner's stored descriptor for this url, or undefined when the url was remembered WITHOUT one
   * (a content-dedup hit that never went through the sink). A memo hit needs the descriptor to build a
   * valid report — the contract refuses an empty storage_key — so an undefined here means "cannot
   * report this one", never a guessed key.
   */
  storedAssetFor(url: string): StoredAsset | undefined;
  /** Record the outcome of one fetch. `stored` is the winner's PUT facts, present only on a real write. */
  remember(url: string, sha256: string, stored?: Omit<StoredAsset, 'sha256'>): void;
}

/**
 * An LRU over `Map`, which iterates in insertion order: re-inserting a key moves it to the end, so
 * the FIRST key is always the least recently used. Two of them, because the two questions have
 * different keys — a url that changes on every deploy (`?v=`) can still resolve to bytes the bucket
 * already holds, and only the content hash sees that.
 */
function lru<V>(max: number): { get(k: string): V | undefined; set(k: string, v: V): void } {
  const entries = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key) as V;
      // Renew: a url that keeps being asked for must not be evicted by a burst of one-off ones.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: V): void {
      if (max <= 0) return;
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/** Build a memo holding at most `size` urls (and as many content addresses). Size 0 ⇒ remembers nothing. */
export function createImageUrlMemo(size: number): ImageUrlMemo {
  const max = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  const byUrl = lru<StoredAsset>(max);
  const bySha = lru<true>(max);
  return {
    hasUrl: (url: string) => byUrl.get(url) !== undefined,
    hasSha: (sha256: string) => bySha.get(sha256) !== undefined,
    shaFor: (url: string) => byUrl.get(url)?.sha256,
    storedAssetFor(url: string): StoredAsset | undefined {
      const entry = byUrl.get(url);
      // A key is what makes a stored capture reportable; a url remembered without one (content-dedup)
      // has an empty key and is deliberately unreportable rather than reported with a guessed one.
      return entry && entry.storageKey ? entry : undefined;
    },
    remember(url: string, sha256: string, stored?: Omit<StoredAsset, 'sha256'>): void {
      byUrl.set(url, {
        sha256,
        storageKey: stored?.storageKey ?? '',
        bytesLen: stored?.bytesLen ?? 0,
        fetchedAt: stored?.fetchedAt ?? '',
        url: stored?.url ?? url,
        ...(stored?.contentType !== undefined ? { contentType: stored.contentType } : {}),
      });
      bySha.set(sha256, true);
    },
  };
}

/** A rolling 24-hour ceiling on bytes carried by the residential exit. */
export interface ResidentialByteBudget {
  /** Bytes recorded within the last 24 hours of `now`. */
  bytesInWindow(now: number): number;
  /** Whether another residential fetch is allowed at `now`. */
  hasRoom(now: number): boolean;
  /** Book bytes that actually crossed the residential line. */
  record(bytes: number, now: number): void;
}

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;

/**
 * A rolling window, not a calendar day. A day-boundary reset lets a run started at 23:50 spend the
 * whole allowance twice in ten minutes; an hourly ring expires the oldest hour continuously, so the
 * line's load over any 24 hours is what the number says it is. Twenty-four buckets is the whole cost.
 *
 * The check is deliberately made BEFORE a fetch and the booking AFTER it, so the last fetch of the
 * day may overshoot by one image. Sizing the window to the byte instead would mean knowing a body's
 * length before requesting it, which no store reliably declares.
 */
export function createResidentialByteBudget(limitBytes: number): ResidentialByteBudget {
  const limit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 0;
  const buckets = new Map<number, number>();

  const prune = (now: number): number => {
    const current = Math.floor(now / HOUR_MS);
    let total = 0;
    for (const [hour, bytes] of buckets) {
      if (hour <= current - WINDOW_HOURS) buckets.delete(hour);
      else total += bytes;
    }
    return total;
  };

  return {
    bytesInWindow: (now: number) => prune(now),
    hasRoom: (now: number) => limit > 0 && prune(now) < limit,
    record(bytes: number, now: number): void {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      const hour = Math.floor(now / HOUR_MS);
      prune(now);
      buckets.set(hour, (buckets.get(hour) ?? 0) + bytes);
    },
  };
}
