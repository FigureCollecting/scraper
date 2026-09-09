/**
 * imageRefs — turning what a RULESET described into what the ENGINE will fetch.
 *
 * The contract's `describeImages` answers a question only the store's own ruleset can: which of this
 * store's field shapes hold image urls, and what does each one mean. This module answers the one only
 * the engine should: given those roles, which images does this landing actually fetch, in what order,
 * and how many.
 *
 * Keeping the two apart is the point. The ROLE vocabulary belongs to the contract and is shared with
 * every ruleset; the CAPTURE RULE below belongs to the engine alone. Fold them together and "stop
 * capturing thumbnails" becomes a contract change and a re-release of 27 rulesets, instead of one
 * line here.
 */
import type { ImageRef, ImageRole } from '@figurecollecting/scraper-plugin-contract';

/**
 * The roles this landing captures, and the reason the other two are absent:
 *
 *   `thumbnail` is a downscaled derivative of a plate the store also publishes at full size. Storing
 *     it spends bytes and a fetch on a worse copy of something already in the corpus.
 *   `user` is a community upload. Whether it may be stored at all is a rights question about someone
 *     else's photograph, and this lane does not answer rights questions — it declines them.
 *
 * `other` rides with `gallery` because it is still an image the STORE published for the item (a box
 * shot, a scale diagram); the distinction it carries is about placement, not provenance.
 */
export const CAPTURED_IMAGE_ROLES: readonly ImageRole[] = ['gallery', 'other'];

/** Every role the contract defines — a ref outside this set is not something a ruleset produced. */
const KNOWN_ROLES: readonly string[] = ['gallery', 'thumbnail', 'user', 'other'];

/** One image the engine has decided to try, with its url resolved against the referencing page. */
export interface PlannedImageRef {
  /** Absolute where it could be resolved; otherwise the ruleset's string, verbatim (see below). */
  url: string;
  role: ImageRole;
  /** The ruleset's own index, carried through untouched — it is stored beside the bytes. */
  position: number;
}

/** The reasons a described image never reaches a fetch. Mirrors the hook's own skip tally. */
export interface ImageRefSkipCounts {
  thumbnailRole: number;
  userRole: number;
  cap: number;
  /**
   * Refused BEFORE the network for a reason that is not a role: a ref with no usable url, or one
   * whose role is not in the contract's vocabulary at all. It shares a counter with the host deny
   * list because it means the same thing to an operator — the engine declined to fetch it.
   */
  policyDeny: number;
}

export interface NormalizedImageRefs {
  refs: PlannedImageRef[];
  skipped: ImageRefSkipCounts;
}

/**
 * Resolve a possibly-relative url against the page it was found on.
 *
 * A url that does NOT resolve is returned VERBATIM rather than dropped. That looks like leniency and
 * is the opposite: `chooseImageLane` refuses anything that is not a fetchable http(s) URL, and the
 * permaban lives on that same path. Dropping malformed urls here would create a second, quieter
 * refusal gate that the deny list does not sit behind — so everything unfetchable goes through the
 * one gate that is authoritative.
 */
function resolveAgainstPage(url: string, pageUrl: string): string {
  try {
    return new URL(url, pageUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Apply the engine's capture rule to a ruleset's described images: keep the capturable roles,
 * resolve each url against the page, collapse a url the ruleset named more than once, and stop at
 * the per-item ceiling.
 *
 * Order is the ruleset's own throughout — it is the order the store presents the images in, and the
 * cap therefore keeps the FIRST `maxPerItem`, which on every store this engine reads are the plates
 * that matter. Nothing here fetches, so the whole decision is pure and reproducible from its inputs.
 */
export function normalizeImageRefs(refs: ImageRef[], pageUrl: string, maxPerItem: number): NormalizedImageRefs {
  const skipped: ImageRefSkipCounts = { thumbnailRole: 0, userRole: 0, cap: 0, policyDeny: 0 };
  const planned: PlannedImageRef[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(refs)) return { refs: planned, skipped };

  for (const ref of refs) {
    const role = (ref as ImageRef | undefined)?.role;
    if (role === 'thumbnail') {
      skipped.thumbnailRole += 1;
      continue;
    }
    if (role === 'user') {
      skipped.userRole += 1;
      continue;
    }
    // An unrecognized role is refused rather than assumed harmless: a role this engine has not been
    // taught is, by definition, one whose capture rule has not been decided.
    if (typeof role !== 'string' || !KNOWN_ROLES.includes(role) || !CAPTURED_IMAGE_ROLES.includes(role as ImageRole)) {
      skipped.policyDeny += 1;
      continue;
    }
    const raw = typeof ref.url === 'string' ? ref.url.trim() : '';
    if (raw === '') {
      skipped.policyDeny += 1;
      continue;
    }
    const url = resolveAgainstPage(raw, pageUrl);
    // The same image named twice is one image. Deduped BEFORE the cap so a store that repeats its
    // hero plate does not spend the item's whole budget on one file.
    if (seen.has(url)) continue;
    seen.add(url);
    const position = typeof ref.position === 'number' && Number.isFinite(ref.position) ? ref.position : planned.length;
    planned.push({ url, role: role as ImageRole, position });
  }

  const cap = Number.isFinite(maxPerItem) && maxPerItem > 0 ? Math.floor(maxPerItem) : 0;
  if (planned.length > cap) {
    skipped.cap = planned.length - cap;
    planned.length = cap;
  }
  return { refs: planned, skipped };
}
