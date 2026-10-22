/**
 * The gallery WORK LIST: one JSON line per item, written by fc-aggregation's `gallery:worklist` (read-only over the
 * spine's `galleryImages` claims), read here. The scraper never opens the spine; this file is the whole interface, so
 * the parser is strict about the shape and tolerant of a bad line (counted, never fatal, never half-applied).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// The canonical spelling: fc-aggregation's `gallery:worklist` produces the same form from the same vectors.
// (test/vectors is duplicated, not shared: a change to one must be made to the other)
const CANONICAL_VECTORS: ReadonlyArray<[string, string, string | undefined]> = [
  ['already canonical', 'https://static.example.net/upload/a.jpg', 'https://static.example.net/upload/a.jpg'],
  ['host in capitals', 'https://STATIC.Example.NET/upload/a.jpg', 'https://static.example.net/upload/a.jpg'],
  ['a trailing dot on the host', 'https://static.example.net./upload/a.jpg', 'https://static.example.net/upload/a.jpg'],
  ['a percent-encoded host', 'http://%6cocalhost:8080/a.jpg', 'http://localhost:8080/a.jpg'],
  ['the default port', 'https://static.example.net:443/a.jpg', 'https://static.example.net/a.jpg'],
  ['a non-default port is kept', 'https://static.example.net:8443/a.jpg', 'https://static.example.net:8443/a.jpg'],
  ['dot segments', 'https://static.example.net/a/b/../c/./d.jpg', 'https://static.example.net/a/c/d.jpg'],
  ['a fragment', 'https://static.example.net/a.jpg#frag', 'https://static.example.net/a.jpg'],
  ['an unreserved character that was escaped', 'https://static.example.net/a%7E%41%2d%2E%5Fb.jpg', 'https://static.example.net/a~A-._b.jpg'],
  ['an escape in lower case', 'https://static.example.net/a%c3%a4.jpg', 'https://static.example.net/a%C3%A4.jpg'],
  ['a non-ASCII character', 'https://static.example.net/\u00e4.jpg', 'https://static.example.net/%C3%A4.jpg'],
  ['a reserved escape stays escaped, in capitals', 'https://static.example.net/a%2fb%3f.jpg', 'https://static.example.net/a%2Fb%3F.jpg'],
  ['a query', 'https://static.example.net/a.jpg?x=%7e&y=%c3%a4', 'https://static.example.net/a.jpg?x=~&y=%C3%A4'],
  ['an empty path', 'https://static.example.net', 'https://static.example.net/'],
  ['credentials have no canonical form', 'https://user:pw@static.example.net/a.jpg', undefined],
  ['not http(s)', 'ftp://static.example.net/a.jpg', undefined],
  ['not a url', 'static.example.net/a.jpg', undefined],
  ['a space', 'https://static.example.net/a b.jpg', undefined],
];

describe('canonicalImageUrl', () => {
  it.each(CANONICAL_VECTORS)('%s', (_why, input, want) => {
    expect(canonicalImageUrl(input)).toBe(want);
  });

  it('is idempotent on every vector, and refuses a non-string or an over-long url', () => {
    for (const [, , want] of CANONICAL_VECTORS) if (want !== undefined) expect(canonicalImageUrl(want)).toBe(want);
    expect(canonicalImageUrl(5)).toBeUndefined();
    expect(canonicalImageUrl('')).toBeUndefined();
    expect(canonicalImageUrl(`https://static.example.net/${'a'.repeat(2100)}`)).toBeUndefined();
  });
});
