/**
 * The gallery WORK LIST: one JSON line per item, written by fc-aggregation's `gallery:worklist` (read-only over the
 * spine's `galleryImages` claims), read here. The scraper never opens the spine; this file is the whole interface, so
 * the parser is strict about the shape and tolerant of a bad line (counted, never fatal, never half-applied).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalImageUrl, parseWorklist, parseWorklistLine, readWorklistFile } from '../../services/images/galleryWorklist';

const STATIC = 'https://static.myfigurecollection.net';
const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    site: 'mfc', itemId: '1005999', pageUrl: 'https://myfigurecollection.net/item/1005999', rank: 0, contentLevel: 'general',
    entries: [{ position: 0, src: `${STATIC}/upload/items/2/1005999-1e7bc.jpg`, w: 600, h: 600 }, { position: 1, src: `${STATIC}/upload/pictures/2022/10/14/3295397.jpeg`, w: 1500, h: 1500 }],
    ...over,
  });

describe('parseWorklistLine', () => {
  it('reads an item with its ordered entries', () => {
    const r = parseWorklistLine(line());
    expect(r).toEqual({
      ok: true,
      item: {
        site: 'mfc', itemId: '1005999', pageUrl: 'https://myfigurecollection.net/item/1005999', rank: 0, contentLevel: 'general',
        entries: [
          { position: 0, src: `${STATIC}/upload/items/2/1005999-1e7bc.jpg`, w: 600, h: 600 },
          { position: 1, src: `${STATIC}/upload/pictures/2022/10/14/3295397.jpeg`, w: 1500, h: 1500 },
        ],
      },
      dropped: 0,
      capped: 0,
    });
  });

  it('keeps the entries in the order given, whatever their positions say', () => {
    const r = parseWorklistLine(line({ entries: [{ position: 5, src: `${STATIC}/b.jpg` }, { position: 2, src: `${STATIC}/a.jpg` }] }));
    expect(r.ok && r.item.entries.map(e => e.position)).toEqual([5, 2]);
  });

  it('gives a missing or bad position its index, and bad dimensions null', () => {
    const r = parseWorklistLine(line({ entries: [{ src: `${STATIC}/a.jpg`, w: 0, h: 'x' }, { position: -1, src: `${STATIC}/b.jpg` }, { position: 1.5, src: `${STATIC}/c.jpg` }] }));
    expect(r.ok && r.item.entries).toEqual([
      { position: 0, src: `${STATIC}/a.jpg`, w: null, h: null },
      { position: 1, src: `${STATIC}/b.jpg`, w: null, h: null },
      { position: 2, src: `${STATIC}/c.jpg`, w: null, h: null },
    ]);
  });

  it('drops an unusable entry and a duplicate, counts them, and keeps the rest', () => {
    const r = parseWorklistLine(line({ entries: [
      { position: 0, src: `${STATIC}/a.jpg` }, { position: 1, src: 'javascript:alert(1)' }, { position: 2, src: '/relative.jpg' },
      { position: 3 }, null, 'x', { position: 4, src: `${STATIC}/a.jpg` }, { position: 5, src: `${STATIC}/b.jpg` },
    ] }));
    expect(r.ok && r.item.entries.map(e => e.src)).toEqual([`${STATIC}/a.jpg`, `${STATIC}/b.jpg`]);
    expect(r.ok && r.dropped).toBe(6);
  });

  it('refuses an item whose entries are all unusable, or empty', () => {
    expect(parseWorklistLine(line({ entries: [] })).ok).toBe(false);
    expect(parseWorklistLine(line({ entries: [{ src: 'ftp://x/y.jpg' }] })).ok).toBe(false);
  });

  // S2: a gallery over the cap is capped, never refused whole
  it('caps a longer gallery at the first 100 by position, and counts the rest, instead of refusing the item', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ position: 149 - i, src: `${STATIC}/${149 - i}.jpg` }));
    const r = parseWorklistLine(line({ entries: many }));
    expect(r.ok && r.item.entries.length).toBe(100);
    expect(r.ok && r.item.entries.map(e => e.position)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(r.ok && r.capped).toBe(50);
  });

  it('exactly 100 is not capped, and equal positions keep their listed order when the cap bites', () => {
    const exact = Array.from({ length: 100 }, (_, i) => ({ position: i, src: `${STATIC}/${i}.jpg` }));
    expect(parseWorklistLine(line({ entries: exact }))).toMatchObject({ ok: true, capped: 0 });
    const ties = Array.from({ length: 102 }, (_, i) => ({ position: 7, src: `${STATIC}/t${i}.jpg` }));
    const r = parseWorklistLine(line({ entries: ties }));
    expect(r.ok && r.item.entries[0]!.src).toBe(`${STATIC}/t0.jpg`);
    expect(r.ok && r.item.entries[99]!.src).toBe(`${STATIC}/t99.jpg`);
    expect(r.ok && r.capped).toBe(2);
  });

  // S3: every entry is carried in the canonical spelling
  it('carries every src in its canonical spelling, and a duplicate spelling is a duplicate', () => {
    const r = parseWorklistLine(line({ entries: [
      { position: 0, src: 'HTTPS://Static.MyFigureCollection.NET./upload/a%7e.jpg#x' },
      { position: 1, src: 'https://static.myfigurecollection.net:443/upload/a~.jpg' },
    ] }));
    expect(r.ok && r.item.entries.map(e => e.src)).toEqual([`${STATIC}/upload/a~.jpg`]);
    expect(r.ok && r.dropped).toBe(1);
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    ['a number', '7'],
    ['no site', line({ site: undefined })],
    ['a blank site', line({ site: ' ' })],
    ['a site with a space', line({ site: 'm fc' })],
    ['no itemId', line({ itemId: undefined })],
    ['a numeric itemId', line({ itemId: 1005999 })],
    ['an overlong itemId', line({ itemId: 'x'.repeat(65) })],
    ['no pageUrl', line({ pageUrl: undefined })],
    ['a non-http pageUrl', line({ pageUrl: 'file:///etc/passwd' })],
    ['no rank', line({ rank: undefined })],
    ['a fractional rank', line({ rank: 1.5 })],
    ['a negative rank', line({ rank: -1 })],
    ['a rank over 99', line({ rank: 100 })],
    ['entries not an array', line({ entries: 'x' })],
  ])('rejects %s with a reason', (_label, text) => {
    const r = parseWorklistLine(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.length).toBeGreaterThan(0);
  });

  it('keeps a content level in the vocabulary, fails an unknown word closed to "unknown", and omits an absent one', () => {
    expect(parseWorklistLine(line({ contentLevel: 'explicit' })).ok && (parseWorklistLine(line({ contentLevel: 'explicit' })) as { item: { contentLevel: string } }).item.contentLevel).toBe('explicit');
    const odd = parseWorklistLine(line({ contentLevel: 'spicy' }));
    expect(odd.ok && odd.item.contentLevel).toBe('unknown');
    const none = parseWorklistLine(line({ contentLevel: undefined }));
    expect(none.ok && 'contentLevel' in none.item).toBe(false);
  });
});

describe('parseWorklist / readWorklistFile', () => {
  it('reads many lines, skips blanks and CRLF, and lists the bad ones by line number', () => {
    const text = [line({ itemId: '1' }), '', line({ itemId: '2' }) + '\r', '{broken', line({ itemId: '3', rank: 200 }), line({ itemId: '4', rank: 9 })].join('\n') + '\n';
    const r = parseWorklist(text);
    expect(r.items.map(i => i.itemId)).toEqual(['1', '2', '4']);
    expect(r.bad.map(b => b.line)).toEqual([4, 5]);
  });

  it('streams a file the same way', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-wl-'));
    try {
      const file = path.join(dir, 'wl.jsonl');
      writeFileSync(file, [line({ itemId: '1' }), '{broken', line({ itemId: '2' })].join('\n'));
      const seen: string[] = [];
      const bad: number[] = [];
      for await (const r of readWorklistFile(file)) {
        if (r.ok) seen.push(r.item.itemId); else bad.push(r.line);
      }
      expect(seen).toEqual(['1', '2']);
      expect(bad).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing file with a clear error', async () => {
    const it = readWorklistFile('/nonexistent/wl.jsonl')[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/wl\.jsonl/);
  });
});

// The canonical spelling: fc-aggregation's `gallery:worklist` produces the same form from the SAME vector file
// (src/__tests__/fixtures/galleryCanonicalVectors.json here, src/gallery/gallery-canonical-vectors.json there: identical
// copies, one sha256 in each test, and the same fuzz digest below pins that the two functions agree).
const CANONICAL_VECTORS = (JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/galleryCanonicalVectors.json'), 'utf8')) as Array<[string, string, string | null]>)
  .map(([why, input, want]) => [why, input, want === null ? undefined : want] as [string, string, string | undefined]);

/** mulberry32: a fixed-seed generator, so the fuzz set is the same on every machine and in both repos. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * 4,000 urls from a fixed seed: half built from single characters that have ever mattered (percent signs and hex digits above all),
 * half from fragments (`%`, `%4`, `%31`, `%25`, ...) so that stray and valid escapes sit next to each other often. The scraper
 * pins the digest of the outputs; fc-aggregation generates the same set and pins the same digest.
 */
function fuzzUrls(n: number): string[] {
  const rnd = mulberry32(0x5eed2026);
  const chars = ['a', 'B', 'z', '0', '9', '%', '%', '%', '%', '4', '1', 'F', 'f', 'E', 'e', '3', '2', '5', '7', '.', '.', '/', '~', '-', '_', '?', '#', '\\', ';', '+', '=', '&', ':', '@', 'é', '\u00c4', ' '];
  const frags = ['%', '%%', '%4', '%3', '%2', '%0', '%G', '%31', '%34', '%41', '%25', '%2e', '%2E', '%7e', '%7E', '4', '1', 'A', 'F', 'x', '.', '..', '/', '?', '=', '#', '\\', 'é', ';', '+', '-', '~'];
  const hosts = ['img.invalid', 'IMG.Invalid.', 'img.invalid:443', 'img.invalid:8443', 'img.invalid../'];
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  return Array.from({ length: n }, (_v, i) => {
    let tail = '';
    if (i % 2 === 0) for (let k = 1 + Math.floor(rnd() * 16); k > 0; k--) tail += pick(chars);
    else for (let k = 1 + Math.floor(rnd() * 8); k > 0; k--) tail += pick(frags);
    return `${pick(['https', 'http', 'HTTPS'])}://${pick(hosts)}/p/${tail}`;
  });
}

describe('canonicalImageUrl', () => {
  it('the shared vector file is the one fc-aggregation carries (62 vectors)', () => {
    const text = readFileSync(path.resolve(__dirname, '../fixtures/galleryCanonicalVectors.json'));
    expect(CANONICAL_VECTORS).toHaveLength(62);
    expect(createHash('sha256').update(text).digest('hex').slice(0, 16)).toBe('5da0901452452ec3');
  });

  it.each(CANONICAL_VECTORS)('%s', (_why, input, want) => {
    expect(canonicalImageUrl(input)).toBe(want);
  });

  it('is idempotent on every vector, and refuses a non-string or an over-long url', () => {
    for (const [, , want] of CANONICAL_VECTORS) if (want !== undefined) expect(canonicalImageUrl(want)).toBe(want);
    expect(canonicalImageUrl(5)).toBeUndefined();
    expect(canonicalImageUrl('')).toBeUndefined();
    expect(canonicalImageUrl(`https://static.example.net/${'a'.repeat(2100)}`)).toBeUndefined();
  });

  it('c(c(x)) === c(x) for every vector input, however many passes the pipeline makes (R2-B2)', () => {
    const bad = CANONICAL_VECTORS.flatMap(([, input]) => {
      const once = canonicalImageUrl(input);
      return once === undefined || canonicalImageUrl(once) === once ? [] : [`${input} -> ${once} -> ${String(canonicalImageUrl(once))}`];
    });
    expect(bad).toEqual([]);
  });

  it('c(c(x)) === c(x) over 4,000 generated urls (fixed seed), and two spellings that differ in a decoded character never meet', () => {
    const urls = fuzzUrls(4000);
    expect(new Set(urls).size).toBeGreaterThan(3500);
    const bad: string[] = [];
    const outputs: Array<string | null> = [];
    for (const u of urls) {
      const once = canonicalImageUrl(u);
      outputs.push(once ?? null);
      if (once === undefined) continue;
      const twice = canonicalImageUrl(once);
      if (twice !== once) bad.push(`${u} -> ${once} -> ${String(twice)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // the fc-aggregation copy computes the same digest over the same fuzz set: the two functions agree
    expect(createHash('sha256').update(JSON.stringify(outputs)).digest('hex').slice(0, 16)).toBe('af640957bd14d471');
  });

  it('a stray percent sign is escaped, so the two files x%4%31 and xA are not the same file', () => {
    expect(canonicalImageUrl('https://img.invalid/p/x%4%31.jpeg')).toBe('https://img.invalid/p/x%2541.jpeg');
    expect(canonicalImageUrl('https://img.invalid/p/x%4%31.jpeg')).not.toBe(canonicalImageUrl('https://img.invalid/p/xA.jpeg'));
  });
});
