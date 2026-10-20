/**
 * captureRedaction — take the SCRAPE ACCOUNT's own data out of a logged-in page before it is stored.
 *
 * WHY: myfigurecollection.net is fetched with the stored login jar (the engine seeds it into the
 * impit session; it is what makes NSFW / age-gated items readable). So every mfc page we keep was
 * rendered FOR that account, and besides the item it carries the account itself: the header menu
 * (avatar, username, notification and message links, content toggles, sign-out), the viewer's state
 * for the item (collected or not, the private note, the lists it is on), the comment composer with
 * the viewer's avatar, and inline ad-tech scripts that push hashed identifiers. The raw store is
 * provenance kept for ever and indexed by url (RAW-MFC-1); none of that belongs in it.
 *
 * WHAT IS REMOVED on an mfc HTML page:
 *   - `.user-menu`, whole;
 *   - the CONTENTS of `.tbx-target-COLLECT`, `.tbx-target-COLLECTION`, `.tbx-target-NOTE` and
 *     `.tbx-target-LISTS` (the empty element stays, so the page keeps its shape);
 *   - every `.user-expression-wrapper` that links the viewer's /profile/ (the comment composer);
 *   - every INLINE script (no src), except JSON-LD — the identity calls live there and cannot be
 *     told apart from the rest by any rule that would survive a site change.
 * WHAT IS KEPT: every other byte, exactly as served. The cut is a splice of the ORIGINAL bytes at the
 * parser's source offsets, never a re-serialization, so the item record, the gallery meta and the
 * rest of the page are byte-for-byte what the store sent, and a reprocess reads what the scrape read.
 *
 * FAILS CLOSED: after the cut the page is checked for the viewer (the name taken from the menu's own
 * /profile/ link) and for a sign-out link. A page that still shows either is REFUSED — not stored —
 * because a redaction that cannot be proven complete is not one.
 *
 * RAW_CAPTURE_ACCOUNT_DATA picks the mode: `keep` stores pages as served; anything else, unset and a
 * typo included, is `redact`.
 */
import { load } from 'cheerio';

export type AccountDataMode = 'redact' | 'keep';

export type RedactionOutcome =
  | { kind: 'untouched' }
  | { kind: 'redacted'; bytes: Buffer }
  | { kind: 'refused'; reason: string };

/** Only an explicit `keep` keeps account data; every other value is the safe default. */
export function accountDataModeFromEnv(env: NodeJS.ProcessEnv = process.env): AccountDataMode {
  return (env.RAW_CAPTURE_ACCOUNT_DATA ?? '').trim().toLowerCase() === 'keep' ? 'keep' : 'redact';
}

/** The hosts that ARE mfc. Subdomains count; a look-alike suffix does not. */
const MFC_HOST = 'myfigurecollection.net';

const VIEWER_STATE = '.tbx-target-COLLECT, .tbx-target-COLLECTION, .tbx-target-NOTE, .tbx-target-LISTS';
const SIGN_OUT = /href\s*=\s*["']?[^"'\s>]*(?:\/session\/|logout)/i;

function isMfc(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === MFC_HOST || host.endsWith(`.${MFC_HOST}`);
}

/** An HTML document, not a JSON or binary answer: the first non-blank bytes open a tag. */
function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text.slice(0, 512));
}

interface Range {
  start: number;
  end: number;
}

interface Located {
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    startTag?: { endOffset: number };
    endTag?: { startOffset: number };
  } | null;
}

/** The element's whole source range, start tag through end tag. */
function whole(el: Located): Range | undefined {
  const loc = el.sourceCodeLocation;
  return loc ? { start: loc.startOffset, end: loc.endOffset } : undefined;
}

/** What lies between the element's tags; the whole element when it was never closed. */
function inner(el: Located): Range | undefined {
  const loc = el.sourceCodeLocation;
  if (!loc) return undefined;
  if (!loc.startTag || !loc.endTag) return { start: loc.startOffset, end: loc.endOffset };
  return { start: loc.startTag.endOffset, end: loc.endTag.startOffset };
}

/** Cut the ranges out of `text`, outermost wins (a range inside another is already gone). */
function splice(text: string, ranges: Range[]): string {
  const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let at = 0;
  for (const r of sorted) {
    if (r.start < at) continue; // nested in a range already cut
    out += text.slice(at, r.start);
    at = r.end;
  }
  return out + text.slice(at);
}

/**
 * Redact one page body for `url`. Untouched unless the url is mfc, the body is HTML, and there is
 * something to remove.
 */
export function redactAccountData(url: string, bytes: Buffer): RedactionOutcome {
  if (!isMfc(url)) return { kind: 'untouched' };
  const text = bytes.toString('utf8');
  if (!looksLikeHtml(text)) return { kind: 'untouched' };

  const $ = load(text, { sourceCodeLocationInfo: true });
  const viewerLink = /\/profile\/([^/?#"'\s]+)/.exec($('.user-menu a[href*="/profile/"]').first().attr('href') ?? '');
  const viewer = viewerLink ? decodeURIComponent(viewerLink[1]).toLowerCase() : undefined;

  const ranges: Range[] = [];
  const add = (r: Range | undefined): void => {
    if (r) ranges.push(r);
  };
  $('.user-menu').each((_, el) => add(whole(el as Located)));
  $(VIEWER_STATE).each((_, el) => add(inner(el as Located)));
  if (viewer !== undefined) {
    $('.user-expression-wrapper').each((_, el) => {
      const ownedByViewer = $(el)
        .find('a[href*="/profile/"]')
        .toArray()
        .some(a => ($(a).attr('href') ?? '').toLowerCase().includes(`/profile/${viewer}`));
      if (ownedByViewer) add(whole(el as Located));
    });
  }
  $('script:not([src])').each((_, el) => {
    if (($(el).attr('type') ?? '').trim().toLowerCase() === 'application/ld+json') return;
    add(whole(el as Located));
  });

  if (ranges.length === 0) return { kind: 'untouched' };
  const cut = splice(text, ranges);

  if (viewer !== undefined && cut.toLowerCase().includes(viewer)) {
    return { kind: 'refused', reason: 'the viewer still appears after the cut' };
  }
  if (SIGN_OUT.test(cut)) return { kind: 'refused', reason: 'a sign-out link survives the cut' };
  return { kind: 'redacted', bytes: Buffer.from(cut, 'utf8') };
}
