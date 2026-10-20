/**
 * captureRedaction — take the SCRAPE ACCOUNT's own data out of a page fetched with its login session
 * before the page is stored.
 *
 * WHY: one store is fetched with a stored LOGIN jar (the engine seeds the host's stored cookies into
 * the impit session; that login is what makes its age-gated items readable). Every page we keep from
 * it was rendered FOR that account, and besides the item it carries the account itself: the header
 * menu (avatar, username, notification and message links, content toggles, sign-out), the viewer's
 * state for the item (collected or not, the private note, the lists it is on), the comment composer
 * with the viewer's avatar, and inline ad-tech scripts that push hashed identifiers. The raw store is
 * provenance kept for ever and indexed by url (RAW-MFC-1); none of that belongs in it.
 *
 * WHEN: only for a page whose host's stored jar holds a cookie other than a Cloudflare clearance
 * cookie — an account session (isAccountSession) — AND whose body shows a signed-in viewer (an account
 * menu linking the viewer's /profile/). Which hosts carry a session is deployment data (the cookie
 * file), so no store is named here. A session cookie alone proves nothing (one store's jar holds an
 * anonymous visitor cookie), so a page that shows no viewer is stored exactly as served — unless it
 * shows a sign-out link, which means a signed-in render this cannot read, and that is refused.
 *
 * WHAT IS REMOVED from such a page (the account chrome of the store fetched logged in today):
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
 * RAW_CAPTURE_ACCOUNT_DATA picks the mode: `keep` stores such pages as served; anything else, unset
 * and a typo included, is `redact`.
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

const VIEWER_STATE = '.tbx-target-COLLECT, .tbx-target-COLLECTION, .tbx-target-NOTE, .tbx-target-LISTS';
const SIGN_OUT = /href\s*=\s*["']?[^"'\s>]*(?:\/session\/|logout)/i;

/** Cloudflare's own cookies: a clearance proves a browser passed a challenge, not who is signed in. */
const CLEARANCE_COOKIE = /^(?:cf_clearance|__cf_bm|__cflb|_cfuvid|cf_chl_.*)$/i;

/** True when a host's stored jar carries a session for an ACCOUNT: any cookie that is not a clearance. */
export function isAccountSession(cookies: Record<string, string> | undefined): boolean {
  return cookies !== undefined && Object.keys(cookies).some(name => !CLEARANCE_COOKIE.test(name));
}

/** A percent-encoded path segment, decoded; the raw segment when it is not valid encoding. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** An HTML document, not a JSON or binary answer: the first non-blank bytes open a tag. */
function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text.slice(0, 512));
}

interface Range {
  start: number;
  end: number;
}

/** Every element of a document parsed with sourceCodeLocationInfo carries its source offsets. */
interface Located {
  sourceCodeLocation: {
    startOffset: number;
    endOffset: number;
    startTag?: { endOffset: number };
    endTag?: { startOffset: number };
  };
}

/** The element's whole source range, start tag through end tag. */
function whole(el: Located): Range {
  const loc = el.sourceCodeLocation;
  return { start: loc.startOffset, end: loc.endOffset };
}

/** What lies between the element's tags; the whole element when it was never closed. */
function inner(el: Located): Range {
  const loc = el.sourceCodeLocation;
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
 * Redact one page body fetched with an account session. Untouched unless the body is HTML and there
 * is something to remove.
 */
export function redactAccountData(bytes: Buffer): RedactionOutcome {
  const text = bytes.toString('utf8');
  if (!looksLikeHtml(text)) return { kind: 'untouched' };

  const $ = load(text, { sourceCodeLocationInfo: true });
  const viewerLink = /\/profile\/([^/?#"'\s]+)/.exec($('.user-menu a[href*="/profile/"]').first().attr('href') ?? '');
  const viewer = viewerLink ? safeDecode(viewerLink[1]).toLowerCase() : undefined;
  if (viewer === undefined || viewer === '') {
    // No viewer it can name. A sign-out link still says someone is signed in: refuse rather than
    // store a render whose account chrome moved where these rules do not look.
    return SIGN_OUT.test(text) ? { kind: 'refused', reason: 'a sign-out link with no account menu to cut' } : { kind: 'untouched' };
  }

  const ranges: Range[] = [];
  const add = (r: Range): void => {
    ranges.push(r);
  };
  $('.user-menu').each((_, el) => add(whole(el as Located)));
  $(VIEWER_STATE).each((_, el) => add(inner(el as Located)));
  $('.user-expression-wrapper').each((_, el) => {
    const ownedByViewer = $(el)
      .find('a[href*="/profile/"]')
      .toArray()
      .some(a => String($(a).attr('href')).toLowerCase().includes(`/profile/${viewer}`));
    if (ownedByViewer) add(whole(el as Located));
  });
  $('script:not([src])').each((_, el) => {
    if (($(el).attr('type') ?? '').trim().toLowerCase() === 'application/ld+json') return;
    add(whole(el as Located));
  });

  const cut = splice(text, ranges);
  if (cut.toLowerCase().includes(viewer)) {
    return { kind: 'refused', reason: 'the viewer still appears after the cut' };
  }
  if (SIGN_OUT.test(cut)) return { kind: 'refused', reason: 'a sign-out link survives the cut' };
  return { kind: 'redacted', bytes: Buffer.from(cut, 'utf8') };
}
