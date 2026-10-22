/**
 * galleryWorklist — the interface between fc-aggregation's `gallery:worklist` and the gallery driver.
 *
 * One JSON object per line:
 *   {"site":"shop","itemId":"1005999","pageUrl":"https://shop.example/item/1005999","rank":0,
 *    "contentLevel":"general","entries":[{"position":0,"src":"https://static.../a.jpg","w":600,"h":600}, ...]}
 * `rank` orders the work (0 owned, 1 ordered, 2 wished, 5 figures and statues, 9 the rest); the file is already in
 * that order and the driver trusts it. The scraper never reads the spine database, so this file is the whole
 * interface — which is why it is parsed strictly (a line either becomes a complete, valid item or is counted and
 * skipped; nothing is half-applied) and why every url is re-checked here and again by the host policy.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ContentLevel } from '@figurecollecting/scraper-plugin-contract';

export const MAX_WORKLIST_ENTRIES = 100;
const MAX_TOKEN_CHARS = 64;
const MAX_SRC_CHARS = 2048;
const MAX_DIMENSION = 100_000;

const CONTENT_LEVELS: ReadonlySet<string> = new Set<ContentLevel>(['general', 'intermediate', 'explicit', 'controversial', 'nsfw', 'nsfw+', 'unknown']);

export interface WorklistEntry { position: number; src: string; w: number | null; h: number | null }
export interface WorklistItem {
  site: string;
  itemId: string;
  /** The item page the images are depicted for: the Referer and the provenance, never fetched. */
  pageUrl: string;
  rank: number;
  /** The item's content level; an unrecognised word fails closed to 'unknown', an absent one stays absent. */
  contentLevel?: ContentLevel;
  entries: WorklistEntry[];
}
export type WorklistLine =
  | { ok: true; item: WorklistItem; dropped: number; /** Entries left out because the item listed more than the cap. */ capped: number }
  | { ok: false; error: string };

const isToken = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_TOKEN_CHARS && !/[\s\u0000-\u001f]/.test(v);
const isHttpUrl = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_SRC_CHARS && /^https?:\/\//i.test(v) && !/[\s\u0000-\u001f]/.test(v) && URL.canParse(v);

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
/**
 * %-escapes in one spelling, in ONE pass over the original text (what a pass writes is never read again, so nothing is decoded twice):
 * a valid `%XX` that spells an unreserved character is written as that character, any other valid escape in upper-case hex, and a
 * stray `%` (one not followed by two hex digits) is a literal percent sign and is written `%25`. Escaping the stray one is what makes
 * the function idempotent: `x%4%31` is the file named `x%41`, and must not become `xA` on a second pass.
 */
const canonicalEscapes = (s: string): string =>
  s.replace(/%([0-9a-fA-F]{2})|%/g, (_m, hex: string | undefined) => {
    if (hex === undefined) return '%25';
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });

/**
 * THE canonical spelling of an image url: the one form the work list carries, the ledger keys on and the fetch asks for
 * (fc-aggregation's `gallery:worklist` produces the same form, from the same vectors). Host lower-cased with no trailing dot,
 * default port gone, dot segments resolved, no fragment, non-ASCII percent-encoded, and every %-escape in one spelling
 * (an unreserved character is never escaped, any other escape is upper-case). An http(s) url with credentials, or one that does
 * not parse, has no canonical form: undefined.
 */
export function canonicalImageUrl(src: unknown): string | undefined {
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_SRC_CHARS || /[\s\u0000-\u001f]/.test(src)) return undefined;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return undefined;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') return undefined;
  u.hash = '';
  u.hostname = u.hostname.replace(/\.+$/, '');
  u.pathname = canonicalEscapes(u.pathname);
  u.search = canonicalEscapes(u.search);
  return u.href;
}
const dimension = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_DIMENSION ? v : null);

/** One line -> a valid item, or the reason it is not one. Never throws. */
export function parseWorklistLine(text: string): WorklistLine {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not a JSON object' };
  const o = raw as Record<string, unknown>;
  if (!isToken(o.site)) return { ok: false, error: 'site must be a short string without whitespace' };
  if (!isToken(o.itemId)) return { ok: false, error: 'itemId must be a short string without whitespace' };
  if (!isHttpUrl(o.pageUrl)) return { ok: false, error: 'pageUrl must be an http(s) url' };
  if (typeof o.rank !== 'number' || !Number.isInteger(o.rank) || o.rank < 0 || o.rank > 99) return { ok: false, error: 'rank must be a whole number from 0 to 99' };
  if (!Array.isArray(o.entries)) return { ok: false, error: 'entries must be an array' };

  const entries: WorklistEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const e of o.entries as unknown[]) {
    const r = e !== null && typeof e === 'object' && !Array.isArray(e) ? e as Record<string, unknown> : undefined;
    const src = r === undefined ? undefined : canonicalImageUrl(r.src);
    if (r === undefined || src === undefined || seen.has(src)) { dropped++; continue; }
    seen.add(src);
    const position = typeof r.position === 'number' && Number.isSafeInteger(r.position) && r.position >= 0 ? r.position : entries.length;
    entries.push({ position, src, w: dimension(r.w), h: dimension(r.h) });
  }
  if (entries.length === 0) return { ok: false, error: 'no usable entry' };
  // A longer gallery is capped, never refused whole: the first MAX_WORKLIST_ENTRIES by position are kept (Array.sort is stable, so
  // equal positions keep their listed order), and how many were left out is reported.
  let capped = 0;
  if (entries.length > MAX_WORKLIST_ENTRIES) {
    entries.sort((a, b) => a.position - b.position);
    capped = entries.length - MAX_WORKLIST_ENTRIES;
    entries.length = MAX_WORKLIST_ENTRIES;
  }

  const item: WorklistItem = { site: o.site, itemId: o.itemId, pageUrl: o.pageUrl, rank: o.rank, entries };
  if (o.contentLevel !== undefined) item.contentLevel = (typeof o.contentLevel === 'string' && CONTENT_LEVELS.has(o.contentLevel) ? o.contentLevel : 'unknown') as ContentLevel;
  return { ok: true, item, dropped, capped };
}

export interface ParsedWorklist { items: WorklistItem[]; bad: Array<{ line: number; error: string }> }

/** A whole work list held in memory (tests, small lists). The driver streams with {@link readWorklistFile}. */
export function parseWorklist(text: string): ParsedWorklist {
  const out: ParsedWorklist = { items: [], bad: [] };
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    const r = parseWorklistLine(line);
    if (r.ok) out.items.push(r.item); else out.bad.push({ line: i + 1, error: r.error });
  });
  return out;
}

/** Stream a work list file line by line (a catalogue list is ~135k lines); a bad line is yielded as such, not thrown. */
export async function* readWorklistFile(file: string): AsyncGenerator<{ ok: true; item: WorklistItem; dropped: number; capped: number } | { ok: false; line: number; error: string }> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const raw of lines) {
      n++;
      if (raw.trim() === '') continue;
      const r = parseWorklistLine(raw);
      if (r.ok) yield r; else yield { ok: false, line: n, error: r.error };
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
