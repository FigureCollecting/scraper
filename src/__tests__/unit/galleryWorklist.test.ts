/**
 * The gallery WORK LIST: one JSON line per item, written by fc-aggregation's `gallery:worklist` (read-only over the
 * spine's `galleryImages` claims), read here. The scraper never opens the spine; this file is the whole interface, so
 * the parser is strict about the shape and tolerant of a bad line (counted, never fatal, never half-applied).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorklist, parseWorklistLine, readWorklistFile } from '../../services/images/galleryWorklist';

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

  it('refuses an item whose entries are all unusable, or empty, or more than 100', () => {
    expect(parseWorklistLine(line({ entries: [] })).ok).toBe(false);
    expect(parseWorklistLine(line({ entries: [{ src: 'ftp://x/y.jpg' }] })).ok).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({ position: i, src: `${STATIC}/${i}.jpg` }));
    const r = parseWorklistLine(line({ entries: many }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/100/);
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
