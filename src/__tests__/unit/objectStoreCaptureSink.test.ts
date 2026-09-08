import { gunzipSync } from 'node:zlib';
import { buildRawCapture } from '../../services/captureSink';
import {
  ObjectStoreCaptureSink,
  type ObjectStore,
  type PutOptions,
  type RawStoreConfig,
} from '../../services/objectStoreCaptureSink';

// A fake S3-compatible store: records PUTs, models a pre-existing corpus for
// dedup, and can be made to hang or fail so we exercise the failure envelope
// (a raw-capture failure must NEVER break a scrape, and must be bounded).
class FakeObjectStore implements ObjectStore {
  readonly puts: Array<{ key: string; body: Buffer; opts: PutOptions }> = [];
  readonly existing = new Set<string>();
  headCalls = 0;
  putDelayMs = 0;
  failPut = false;
  hangPut = false;
  hangExists = false;

  async exists(key: string): Promise<boolean> {
    this.headCalls += 1;
    if (this.hangExists) return new Promise<boolean>(() => {}); // never resolves
    return this.existing.has(key);
  }

  async put(key: string, body: Buffer, opts: PutOptions): Promise<void> {
    if (this.hangPut) return new Promise<void>(() => {}); // never resolves
    if (this.putDelayMs) await new Promise(r => setTimeout(r, this.putDelayMs));
    if (this.failPut) throw new Error('simulated store failure');
    this.puts.push({ key, body, opts });
    this.existing.add(key);
  }
}

const CONFIG: RawStoreConfig = {
  endpoint: 'https://hel1.your-objectstorage.com',
  region: 'hel1',
  bucket: 'mindsignals-raw',
  prefix: 'raw-html/',
  keyScheme: 'sha256-v1',
  putTimeoutMs: 100,
};

// Fixed bytes → deterministic sha256 so we can assert the exact key.
const HTML = Buffer.from('<html><body>figure 12345</body></html>', 'utf8');
const cap = (over: Partial<Parameters<typeof buildRawCapture>[0]> = {}) =>
  buildRawCapture({
    url: 'https://myfigurecollection.net/item/12345',
    lane: 'wire',
    bytes: HTML,
    statusCode: 200,
    contentType: 'text/html',
    fetchedAt: '2026-07-31T00:00:00.000Z',
    ...over,
  });

describe('ObjectStoreCaptureSink — sha256-v1 contract', () => {
  let store: FakeObjectStore;
  let sink: ObjectStoreCaptureSink;

  beforeEach(() => {
    store = new FakeObjectStore();
    sink = new ObjectStoreCaptureSink(store, CONFIG);
  });

  it('refuses to construct against an unknown key scheme', () => {
    expect(() => new ObjectStoreCaptureSink(store, { ...CONFIG, keyScheme: 'sha256-v2' }))
      .toThrow(/sha256-v1/);
  });

  it('writes to the content-addressed key: <prefix>sha256/<aa>/<hex>.html.gz', async () => {
    const c = cap();
    await sink.capture(c);

    expect(store.puts).toHaveLength(1);
    const expectedKey = `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;
    expect(store.puts[0].key).toBe(expectedKey);
  });

  it('stores gzip(content) with Content-Type application/gzip and no content-encoding', async () => {
    const c = cap();
    await sink.capture(c);

    const { body, opts } = store.puts[0];
    // Object bytes are gzip of the EXACT uncompressed bytes (hash-before-compress).
    expect(gunzipSync(body).equals(HTML)).toBe(true);
    expect(opts.contentType).toBe('application/gzip');
    // The .gz suffix declares compression; Content-Encoding must NOT be set.
    expect(opts.contentEncoding).toBeUndefined();
    expect(opts.metadata?.['content-encoding']).toBeUndefined();
  });

  it('attaches convenience metadata (url + fetched-at + site) on the first PUT', async () => {
    await sink.capture(cap({ url: 'https://x.test/a', finalUrl: 'https://x.test/a?', fetchedAt: '2026-07-31T00:00:00.000Z' }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['url']).toBe('https://x.test/a?'); // finalUrl preferred when present
    expect(md['fetched-at']).toBe('2026-07-31T00:00:00.000Z');
    expect(md['site']).toBe('x.test');
  });

  it('header-safes a non-ASCII / hostile URL in metadata so it cannot fail the PUT', async () => {
    await sink.capture(cap({ url: 'https://x.test/日本\r\ninject', finalUrl: undefined }));
    const urlTag = store.puts[0].opts.metadata?.['url'] ?? '';
    expect(urlTag).not.toMatch(/[\r\n]/); // no CRLF header injection
    expect(urlTag).toMatch(/^[\x20-\x7e]*$/); // pure printable ASCII
  });

  it('omits the site tag when the URL is malformed (best-effort metadata)', async () => {
    await sink.capture(cap({ url: 'not a valid url', finalUrl: undefined }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['site']).toBeUndefined();
    expect(md['url']).toBeDefined();
  });

  it('is idempotent: HEAD-then-PUT skips the write when the content address already exists', async () => {
    const c = cap();
    const key = `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;
    store.existing.add(key); // corpus already holds this content

    await sink.capture(c);

    expect(store.headCalls).toBe(1);
    expect(store.puts).toHaveLength(0); // dedup hit — no PUT
    expect(sink.stats().deduped).toBe(1);
  });

  it('writes exactly once across repeated captures of identical content', async () => {
    await sink.capture(cap());
    await sink.capture(cap());
    await sink.capture(cap());
    expect(store.puts).toHaveLength(1);
    expect(sink.stats()).toMatchObject({ stored: 1, deduped: 2 });
  });

  it('routes the api lane to a json object (raw-json/…json.gz)', async () => {
    const c = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{"ok":true}', 'utf8') });
    await sink.capture(c);
    expect(store.puts[0].key).toBe(`raw-json/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.json.gz`);
  });

  it('uses an explicit jsonPrefix for the api lane when configured', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, jsonPrefix: 'api-raw/' });
    const c = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{}', 'utf8') });
    await s.capture(c);
    expect(store.puts[0].key).toBe(`api-raw/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.json.gz`);
  });

  it('does not corrupt a non-raw-html prefix when deriving the json sibling', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, prefix: 'custom/', jsonPrefix: undefined });
    const c = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{}', 'utf8') });
    await s.capture(c);
    expect(store.puts[0].key).toBe(`custom/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.json.gz`);
  });

  it('never throws when the store fails — it swallows and counts the failure', async () => {
    store.failPut = true;
    await expect(sink.capture(cap())).resolves.toBeUndefined();
    expect(sink.stats().failed).toBe(1);
  });

  it('bounds a hung PUT by putTimeoutMs instead of stalling the scrape', async () => {
    store.hangPut = true;
    const start = Date.now();
    await expect(sink.capture(cap())).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000); // resolved via the 100ms bound, not hung
    expect(sink.stats().failed).toBe(1);
  });

  it('bounds a hung HEAD by putTimeoutMs (not only the PUT)', async () => {
    store.hangExists = true;
    const start = Date.now();
    await expect(sink.capture(cap())).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(sink.stats().failed).toBe(1);
  });

  it('falls back to the default timeout when putTimeoutMs is invalid (NaN/0)', async () => {
    // A 0/NaN bound must NOT make every op time out immediately.
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 0 });
    await expect(s.capture(cap())).resolves.toBeUndefined();
    expect(s.stats().stored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The asset lane: originals stored UNALTERED (no gzip), typed by magic bytes.
// ---------------------------------------------------------------------------

/** Minimal, magic-byte-correct heads for each format the lane accepts. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('\0\x10JFIF\0', 'binary')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary');
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypavifavif')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');

const asset = (bytes: Buffer, over: Partial<Parameters<typeof buildRawCapture>[0]> = {}) =>
  buildRawCapture({
    url: 'https://cdn.x.test/img/9.jpg',
    lane: 'asset',
    bytes,
    statusCode: 200,
    contentType: 'image/jpeg',
    fetchedAt: '2026-09-08T00:00:00.000Z',
    sourceItem: { site: 'x.test', itemId: '12345' },
    sourceUrl: 'https://x.test/item/12345',
    position: 2,
    ...over,
  });

describe('ObjectStoreCaptureSink — the asset lane', () => {
  let store: FakeObjectStore;
  let sink: ObjectStoreCaptureSink;

  beforeEach(() => {
    store = new FakeObjectStore();
    sink = new ObjectStoreCaptureSink(store, CONFIG);
  });

  it.each([
    ['jpeg', JPEG, 'jpg', 'image/jpeg'],
    ['png', PNG, 'png', 'image/png'],
    ['webp', WEBP, 'webp', 'image/webp'],
    ['gif', GIF, 'gif', 'image/gif'],
    ['avif', AVIF, 'avif', 'image/avif'],
  ])('stores a %s unaltered at raw-img/sha256/<aa>/<hex>.%s with its real Content-Type', async (_n, bytes, ext, ct) => {
    const c = asset(bytes as Buffer);
    await sink.capture(c);

    expect(store.puts).toHaveLength(1);
    const { key, body, opts } = store.puts[0];
    expect(key).toBe(`raw-img/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.${ext}`);
    expect(body.equals(bytes as Buffer)).toBe(true); // NOT gzipped — the original, byte for byte
    expect(opts.contentType).toBe(ct);
    expect(opts.contentEncoding).toBeUndefined();
    expect(sink.stats().assetStored).toBe(1);
  });

  it('sniffs the bytes rather than trusting the declared Content-Type, and records both', async () => {
    const c = asset(PNG, { contentType: 'application/octet-stream' });
    await sink.capture(c);

    const { key, opts } = store.puts[0];
    expect(key.endsWith('.png')).toBe(true);
    expect(opts.contentType).toBe('image/png'); // sniffed wins
    expect(opts.metadata?.['declared-content-type']).toBe('application/octet-stream');
  });

  it('tags the asset with its item provenance', async () => {
    await sink.capture(asset(JPEG));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['url']).toBe('https://cdn.x.test/img/9.jpg');
    expect(md['fetched-at']).toBe('2026-09-08T00:00:00.000Z');
    expect(md['site']).toBe('x.test'); // the DECLARING store, not the CDN host
    expect(md['source-item']).toBe('x.test/12345');
    expect(md['source-url']).toBe('https://x.test/item/12345');
    expect(md['position']).toBe('2');
    expect(md['lane']).toBe('asset');
    expect(md['declared-content-type']).toBe('image/jpeg');
    expect(md['bytes']).toBe(String(JPEG.length));
  });

  it('falls back to the image host for site when no source item is carried', async () => {
    await sink.capture(asset(JPEG, { sourceItem: undefined, sourceUrl: undefined, position: undefined }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['site']).toBe('cdn.x.test');
    expect(md['source-item']).toBeUndefined();
    expect(md['source-url']).toBeUndefined();
    expect(md['position']).toBeUndefined();
  });

  it('uses a configured imagePrefix', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, imagePrefix: 'img/' });
    const c = asset(PNG);
    await s.capture(c);
    expect(store.puts[0].key).toBe(`img/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.png`);
  });

  it('writes once and dedupes identical asset bytes', async () => {
    await sink.capture(asset(JPEG));
    await sink.capture(asset(JPEG));
    expect(store.puts).toHaveLength(1);
    expect(sink.stats()).toMatchObject({ assetStored: 1, assetDeduped: 1 });
  });

  it.each([
    ['html', Buffer.from('<!doctype html><html></html>', 'utf8')],
    ['json', Buffer.from('{"a":1}', 'utf8')],
    ['svg', SVG],
    ['plain text', Buffer.from('not an image at all', 'utf8')],
  ])('SKIPS a %s body as notImage instead of storing or throwing', async (_n, bytes) => {
    await expect(sink.capture(asset(bytes as Buffer))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
    expect(store.headCalls).toBe(0); // skipped before any store op
    expect(sink.stats().assetSkipped).toEqual({ notImage: 1, tooLarge: 0, empty: 0 });
    expect(sink.stats().assetFailed).toBe(0);
  });

  it('SKIPS an oversized image as tooLarge (RAW_STORE_IMAGE_MAX_BYTES, default 10 MiB)', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(sink.capture(asset(big))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
    expect(sink.stats().assetSkipped).toEqual({ notImage: 0, tooLarge: 1, empty: 0 });
  });

  it('honours a configured maxImageBytes', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, maxImageBytes: 4 });
    await s.capture(asset(JPEG));
    expect(store.puts).toHaveLength(0);
    expect(s.stats().assetSkipped.tooLarge).toBe(1);
  });

  it('SKIPS an empty body as empty', async () => {
    await expect(sink.capture(asset(Buffer.alloc(0)))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
    expect(sink.stats().assetSkipped).toEqual({ notImage: 0, tooLarge: 0, empty: 1 });
  });

  it('counts an asset store failure as assetFailed, never throwing', async () => {
    store.failPut = true;
    await expect(sink.capture(asset(JPEG))).resolves.toBeUndefined();
    expect(sink.stats()).toMatchObject({ assetFailed: 1, failed: 0 });
  });

  it('keeps the asset counters separate from the page-body counters', async () => {
    await sink.capture(asset(JPEG));
    await sink.capture(cap());
    expect(sink.stats()).toEqual({
      stored: 1,
      deduped: 0,
      failed: 0,
      assetStored: 1,
      assetDeduped: 0,
      assetFailed: 0,
      assetSkipped: { notImage: 0, tooLarge: 0, empty: 0 },
    });
  });

  it('leaves the wire/dom/api lanes byte-identical: still gzip, still .html.gz/.json.gz', async () => {
    const w = cap();
    const a = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{"ok":true}', 'utf8') });
    await sink.capture(w);
    await sink.capture(a);

    const html = store.puts.find(p => p.key.endsWith('.html.gz'))!;
    const json = store.puts.find(p => p.key.endsWith('.json.gz'))!;
    expect(html.key).toBe(`raw-html/sha256/${w.sha256.slice(0, 2)}/${w.sha256}.html.gz`);
    expect(gunzipSync(html.body).equals(HTML)).toBe(true);
    expect(html.opts.contentType).toBe('application/gzip');
    expect(Object.keys(html.opts.metadata ?? {}).sort()).toEqual(['fetched-at', 'site', 'url']);
    expect(json.key).toBe(`raw-json/sha256/${a.sha256.slice(0, 2)}/${a.sha256}.json.gz`);
    expect(json.opts.contentType).toBe('application/gzip');
  });

  it('never lets an image content-type on a PAGE lane divert it to the image prefix', async () => {
    await sink.capture(cap({ contentType: 'image/png' }));
    expect(store.puts[0].key.startsWith('raw-html/')).toBe(true);
    expect(store.puts[0].key.endsWith('.html.gz')).toBe(true);
  });
});
