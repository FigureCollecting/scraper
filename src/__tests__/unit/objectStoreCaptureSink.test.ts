import { jest } from '@jest/globals';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildRawCapture, type RawCapture } from '../../services/captureSink';
import {
  ObjectStoreCaptureSink,
  DEFAULT_IMAGE_PUT_TIMEOUT_MS,
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

/**
 * capture() ADMITS a capture to the sink's internal queue and returns — the HEAD/PUT
 * runs on a worker, so the fetch path is never held behind the object store. Every
 * assertion about what actually reached the store therefore drains the queue first.
 */
const send = async (s: ObjectStoreCaptureSink, c: RawCapture): Promise<void> => {
  await s.capture(c);
  await s.flush();
};

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
    await send(sink, c);

    expect(store.puts).toHaveLength(1);
    const expectedKey = `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;
    expect(store.puts[0].key).toBe(expectedKey);
  });

  it('stores gzip(content) with Content-Type application/gzip and no content-encoding', async () => {
    const c = cap();
    await send(sink, c);

    const { body, opts } = store.puts[0];
    // Object bytes are gzip of the EXACT uncompressed bytes (hash-before-compress).
    expect(gunzipSync(body).equals(HTML)).toBe(true);
    expect(opts.contentType).toBe('application/gzip');
    // The .gz suffix declares compression; Content-Encoding must NOT be set.
    expect(opts.contentEncoding).toBeUndefined();
    expect(opts.metadata?.['content-encoding']).toBeUndefined();
  });

  it('attaches convenience metadata (url + fetched-at + site) on the first PUT', async () => {
    await send(sink, cap({ url: 'https://x.test/a', finalUrl: 'https://x.test/a?', fetchedAt: '2026-07-31T00:00:00.000Z' }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['url']).toBe('https://x.test/a?'); // finalUrl preferred when present
    expect(md['fetched-at']).toBe('2026-07-31T00:00:00.000Z');
    expect(md['site']).toBe('x.test');
  });

  it('header-safes a non-ASCII / hostile URL in metadata so it cannot fail the PUT', async () => {
    await send(sink, cap({ url: 'https://x.test/日本\r\ninject', finalUrl: undefined }));
    const urlTag = store.puts[0].opts.metadata?.['url'] ?? '';
    expect(urlTag).not.toMatch(/[\r\n]/); // no CRLF header injection
    expect(urlTag).toMatch(/^[\x20-\x7e]*$/); // pure printable ASCII
  });

  it('omits the site tag when the URL is malformed (best-effort metadata)', async () => {
    await send(sink, cap({ url: 'not a valid url', finalUrl: undefined }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['site']).toBeUndefined();
    expect(md['url']).toBeDefined();
  });

  it('is idempotent: HEAD-then-PUT skips the write when the content address already exists', async () => {
    const c = cap();
    const key = `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;
    store.existing.add(key); // corpus already holds this content

    await send(sink, c);

    expect(store.headCalls).toBe(1);
    expect(store.puts).toHaveLength(0); // dedup hit — no PUT
    expect(sink.stats().deduped).toBe(1);
  });

  it('writes exactly once across repeated captures of identical content', async () => {
    await send(sink, cap());
    await send(sink, cap());
    await send(sink, cap());
    expect(store.puts).toHaveLength(1);
    expect(sink.stats()).toMatchObject({ stored: 1, deduped: 2 });
  });

  it('routes the api lane to a json object (raw-json/…json.gz)', async () => {
    const c = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{"ok":true}', 'utf8') });
    await send(sink, c);
    expect(store.puts[0].key).toBe(`raw-json/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.json.gz`);
  });

  it('uses an explicit jsonPrefix for the api lane when configured', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, jsonPrefix: 'api-raw/' });
    const c = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{}', 'utf8') });
    await send(s, c);
    expect(store.puts[0].key).toBe(`api-raw/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.json.gz`);
  });

  it('does not corrupt a non-raw-html prefix when deriving the json sibling', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, prefix: 'custom/', jsonPrefix: undefined });
    const c = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{}', 'utf8') });
    await send(s, c);
    expect(store.puts[0].key).toBe(`custom/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.json.gz`);
  });

  it('never throws when the store fails — it swallows and counts the failure', async () => {
    store.failPut = true;
    await expect(send(sink, cap())).resolves.toBeUndefined();
    expect(sink.stats().failed).toBe(1);
  });

  it('bounds a hung PUT by putTimeoutMs instead of stalling the scrape', async () => {
    store.hangPut = true;
    const start = Date.now();
    await expect(send(sink, cap())).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000); // resolved via the 100ms bound, not hung
    expect(sink.stats().failed).toBe(1);
  });

  it('bounds a hung HEAD by putTimeoutMs (not only the PUT)', async () => {
    store.hangExists = true;
    const start = Date.now();
    await expect(send(sink, cap())).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(sink.stats().failed).toBe(1);
  });

  it('falls back to the default timeout when putTimeoutMs is invalid (NaN/0)', async () => {
    // A 0/NaN bound must NOT make every op time out immediately.
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 0 });
    await expect(send(s, cap())).resolves.toBeUndefined();
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
    await send(sink, c);

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
    await send(sink, c);

    const { key, opts } = store.puts[0];
    expect(key.endsWith('.png')).toBe(true);
    expect(opts.contentType).toBe('image/png'); // sniffed wins
    expect(opts.metadata?.['declared-content-type']).toBe('application/octet-stream');
  });

  it('tags the asset with its item provenance', async () => {
    await send(sink, asset(JPEG));
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

  it('records the NEGOTIATION witnesses, so a re-encoded response is visible in the object', async () => {
    // The archival Accept asks for originals; a Polish/Shopify host may still answer with a
    // rendition. `vary: Accept` says the response was chosen from the request header and
    // `content-encoding` says the wire body was not the stored one — neither is readable from the
    // bytes afterwards, so both are kept beside the type the store declared.
    await send(sink, asset(JPEG, { contentType: 'image/webp', contentEncoding: 'br', vary: 'Accept' }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['declared-content-type']).toBe('image/webp');
    expect(md['content-encoding']).toBe('br');
    expect(md['vary']).toBe('Accept');
  });

  it('omits both witnesses when the server sent neither', async () => {
    await send(sink, asset(JPEG));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md).not.toHaveProperty('content-encoding');
    expect(md).not.toHaveProperty('vary');
  });

  it('falls back to the image host for site when no source item is carried', async () => {
    await send(sink, asset(JPEG, { sourceItem: undefined, sourceUrl: undefined, position: undefined }));
    const md = store.puts[0].opts.metadata ?? {};
    expect(md['site']).toBe('cdn.x.test');
    expect(md['source-item']).toBeUndefined();
    expect(md['source-url']).toBeUndefined();
    expect(md['position']).toBeUndefined();
  });

  it('uses a configured imagePrefix', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, imagePrefix: 'img/' });
    const c = asset(PNG);
    await send(s, c);
    expect(store.puts[0].key).toBe(`img/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.png`);
  });

  it('writes once and dedupes identical asset bytes', async () => {
    await send(sink, asset(JPEG));
    await send(sink, asset(JPEG));
    expect(store.puts).toHaveLength(1);
    expect(sink.stats()).toMatchObject({ assetStored: 1, assetDeduped: 1 });
  });

  it.each([
    ['html', Buffer.from('<!doctype html><html></html>', 'utf8')],
    ['json', Buffer.from('{"a":1}', 'utf8')],
    ['svg', SVG],
    ['plain text', Buffer.from('not an image at all', 'utf8')],
  ])('SKIPS a %s body as notImage instead of storing or throwing', async (_n, bytes) => {
    await expect(send(sink, asset(bytes as Buffer))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
    expect(store.headCalls).toBe(0); // skipped before any store op
    expect(sink.stats().assetSkipped).toEqual({ notImage: 1, tooLarge: 0, empty: 0, disabled: 0 });
    expect(sink.stats().assetFailed).toBe(0);
  });

  it('SKIPS an oversized image as tooLarge (RAW_STORE_IMAGE_MAX_BYTES, default 10 MiB)', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(send(sink, asset(big))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
    expect(sink.stats().assetSkipped).toEqual({ notImage: 0, tooLarge: 1, empty: 0, disabled: 0 });
  });

  it('honours a configured maxImageBytes', async () => {
    const s = new ObjectStoreCaptureSink(store, { ...CONFIG, maxImageBytes: 4 });
    await send(s, asset(JPEG));
    expect(store.puts).toHaveLength(0);
    expect(s.stats().assetSkipped.tooLarge).toBe(1);
  });

  it('SKIPS an empty body as empty', async () => {
    await expect(send(sink, asset(Buffer.alloc(0)))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
    expect(sink.stats().assetSkipped).toEqual({ notImage: 0, tooLarge: 0, empty: 1, disabled: 0 });
  });

  it('counts an asset store failure as assetFailed, never throwing', async () => {
    store.failPut = true;
    await expect(send(sink, asset(JPEG))).resolves.toBeUndefined();
    expect(sink.stats()).toMatchObject({ assetFailed: 1, failed: 0 });
  });

  it('keeps the asset counters separate from the page-body counters', async () => {
    await send(sink, asset(JPEG));
    await send(sink, cap());
    expect(sink.stats()).toEqual({
      stored: 1,
      deduped: 0,
      failed: 0,
      skippedDisabled: 0,
      assetStored: 1,
      assetDeduped: 0,
      assetFailed: 0,
      assetSkipped: { notImage: 0, tooLarge: 0, empty: 0, disabled: 0 },
      // The queue's own view, drained: nothing waiting, nothing running, nothing lost.
      queued: 0,
      inFlight: 0,
      dropped: 0,
      queueWaitP50: 0,
      queueWaitP95: 0,
      putP50: 0,
      putP95: 0,
    });
  });

  it('leaves the wire/dom/api lanes byte-identical: still gzip, still .html.gz/.json.gz', async () => {
    const w = cap();
    const a = cap({ lane: 'api', contentType: 'application/json', bytes: Buffer.from('{"ok":true}', 'utf8') });
    await send(sink, w);
    await send(sink, a);

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
    await send(sink, cap({ contentType: 'image/png' }));
    expect(store.puts[0].key.startsWith('raw-html/')).toBe(true);
    expect(store.puts[0].key.endsWith('.html.gz')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The kill switches are enforced at the WRITE boundary, not only by convention:
// a caller that ignores PERSIST_RAW_IMAGES must still not put bytes in the bucket.
// ---------------------------------------------------------------------------
describe('ObjectStoreCaptureSink — per-lane enable flags', () => {
  let store: FakeObjectStore;

  beforeEach(() => {
    store = new FakeObjectStore();
  });

  it('refuses the asset lane when assetsEnabled is false — counted as a disabled skip, no store op', async () => {
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, assetsEnabled: false });
    await send(sink, asset(JPEG));

    expect(store.puts).toHaveLength(0);
    expect(store.headCalls).toBe(0);
    expect(sink.stats().assetSkipped.disabled).toBe(1);
    expect(sink.stats().assetStored).toBe(0);
  });

  it('refuses the page lanes when pagesEnabled is false — counted, no store op', async () => {
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, pagesEnabled: false });
    await send(sink, cap());
    await send(sink, cap({ lane: 'api', bytes: Buffer.from('{"a":1}', 'utf8') }));

    expect(store.puts).toHaveLength(0);
    expect(store.headCalls).toBe(0);
    expect(sink.stats().skippedDisabled).toBe(2);
    expect(sink.stats().stored).toBe(0);
  });

  it('runs one lane while the other is off (images-only wiring stores images, never pages)', async () => {
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, pagesEnabled: false, assetsEnabled: true });
    await send(sink, cap());
    await send(sink, asset(PNG));

    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].key.startsWith('raw-img/')).toBe(true);
    expect(sink.stats().skippedDisabled).toBe(1);
    expect(sink.stats().assetStored).toBe(1);
  });

  it('defaults both lanes ON when the flags are absent (existing construction is unchanged)', async () => {
    const sink = new ObjectStoreCaptureSink(store, CONFIG);
    await send(sink, cap());
    await send(sink, asset(JPEG));
    expect(sink.stats().stored).toBe(1);
    expect(sink.stats().assetStored).toBe(1);
    expect(sink.stats().skippedDisabled).toBe(0);
    expect(sink.stats().assetSkipped.disabled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S3 caps USER METADATA as a SET (~2 KB of header bytes), not per value. Two of
// the asset lane's inputs are wholly store-controlled (the image URL it serves and
// the Content-Type header it returns), so an unbudgeted set is a way for a hostile
// store to 400 every one of its own images out of the corpus.
// ---------------------------------------------------------------------------

/** The header bytes S3 actually counts: `x-amz-meta-<key>` + value, summed. */
const metadataBytes = (md: Record<string, string> = {}) =>
  Object.entries(md).reduce(
    (n, [k, v]) => n + Buffer.byteLength(`x-amz-meta-${k}`, 'utf8') + Buffer.byteLength(v, 'utf8'),
    0,
  );

describe('ObjectStoreCaptureSink — user-metadata is budgeted as a whole', () => {
  let store: FakeObjectStore;
  let sink: ObjectStoreCaptureSink;

  beforeEach(() => {
    store = new FakeObjectStore();
    sink = new ObjectStoreCaptureSink(store, CONFIG);
  });

  const LONG_IMG = `https://cdn.x.test/i/${'a'.repeat(2000)}.jpg`;
  const LONG_PAGE = `https://x.test/item/${'b'.repeat(2000)}`;

  it('keeps a hostile asset metadata set under the S3 ceiling instead of failing the PUT', async () => {
    await send(sink, 
      asset(JPEG, {
        url: LONG_IMG,
        sourceUrl: LONG_PAGE,
        contentType: `image/jpeg;${'c'.repeat(1500)}`,
      }),
    );

    expect(store.puts).toHaveLength(1);
    expect(metadataBytes(store.puts[0].opts.metadata)).toBeLessThan(2048);
    expect(sink.stats().assetStored).toBe(1);
  });

  it('sheds the least valuable provenance first: the negotiation witnesses, then declared-content-type, then source-url', async () => {
    await send(sink, 
      asset(JPEG, {
        url: LONG_IMG,
        sourceUrl: LONG_PAGE,
        contentType: `image/jpeg;${'c'.repeat(1500)}`,
        contentEncoding: 'br',
        vary: 'Accept',
      }),
    );
    const md = store.puts[0].opts.metadata!;
    expect(md['vary']).toBeUndefined();
    expect(md['content-encoding']).toBeUndefined();
    expect(md['declared-content-type']).toBeUndefined();
    expect(md['source-item']).toBe('x.test/12345'); // the identity survives
    expect(md.url).toBeDefined();
  });

  it('budgets the page lanes too — a hostile URL cannot blow their metadata either', async () => {
    await send(sink, cap({ url: `https://${'d'.repeat(1200)}.test/${'e'.repeat(1200)}` }));
    expect(metadataBytes(store.puts[0].opts.metadata)).toBeLessThan(2048);
  });

  it('leaves an ordinary asset metadata set completely intact', async () => {
    await send(sink, asset(JPEG));
    expect(Object.keys(store.puts[0].opts.metadata!).sort()).toEqual([
      'bytes', 'declared-content-type', 'fetched-at', 'lane', 'position', 'site', 'source-item', 'source-url', 'url',
    ]);
  });

  it('header-safes every metadata value, including fetched-at and position', async () => {
    await send(sink, 
      asset(JPEG, {
        fetchedAt: '2026-09-08T00:00:00.000Z\r\nx-amz-acl: public-read',
        position: '3\r\nx-amz-acl: public-read' as unknown as number,
      }),
    );
    const md = store.puts[0].opts.metadata!;
    expect(md['fetched-at']).not.toMatch(/[\r\n]/);
    expect(md.position).not.toMatch(/[\r\n]/);
  });
});


// ---------------------------------------------------------------------------
// A 10 MiB image needs ~2 MiB/s to fit the page lanes' 5 s budget. The asset lane
// gets its OWN budget so a large original is not counted as a failure that in fact
// completed behind the sink's back.
// ---------------------------------------------------------------------------
describe('ObjectStoreCaptureSink — the asset lane has its own op budget', () => {
  it('defaults the asset budget well above the page budget', () => {
    expect(DEFAULT_IMAGE_PUT_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it('bounds a hung asset PUT by imagePutTimeoutMs, not by the page putTimeoutMs', async () => {
    const store = new FakeObjectStore();
    store.hangPut = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 50, imagePutTimeoutMs: 300 });

    let settled = false;
    const done = send(sink, asset(JPEG)).then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 150));
    expect(settled).toBe(false); // the page lane's 50ms did NOT apply
    await done;
    expect(sink.stats().assetFailed).toBe(1);
  });

  it('leaves the page lanes on their own putTimeoutMs', async () => {
    const store = new FakeObjectStore();
    store.hangPut = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 50, imagePutTimeoutMs: 5_000 });
    await send(sink, cap());
    expect(sink.stats().failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What the sniffer must and must not promise. It types the PREFIX; it does not
// validate the tail, and it must never be the thing that throws out of capture().
// ---------------------------------------------------------------------------
describe('ObjectStoreCaptureSink — sniffing is total and never throws', () => {
  let store: FakeObjectStore;
  let sink: ObjectStoreCaptureSink;

  beforeEach(() => {
    store = new FakeObjectStore();
    sink = new ObjectStoreCaptureSink(store, CONFIG);
  });

  it('accepts AVIF whose MAJOR brand is mif1 with avif among the compatible brands', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 0x1c]),
      Buffer.from('ftypmif1'),
      Buffer.from([0, 0, 0, 0]), // minor version
      Buffer.from('mif1avifmiaf'), // the compatible-brand list
    ]);
    await send(sink, asset(bytes));
    expect(store.puts[0].key.endsWith('.avif')).toBe(true);
    expect(store.puts[0].opts.contentType).toBe('image/avif');
  });

  it('still refuses a non-AVIF ISO-BMFF container (an mp4 is not an image)', async () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisomisomiso2')]);
    await send(sink, asset(mp4));
    expect(store.puts).toHaveLength(0);
    expect(sink.stats().assetSkipped.notImage).toBe(1);
  });

  it('handles a plain Uint8Array body (what `new Uint8Array(await res.arrayBuffer())` yields)', async () => {
    const view = new Uint8Array(PNG) as unknown as Buffer;
    await expect(send(sink, asset(view))).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].key.endsWith('.png')).toBe(true);
    expect(sink.stats().assetFailed).toBe(0);
  });

  it('COUNTS a malformed capture instead of rejecting out of capture()', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { ...asset(JPEG), bytes: undefined as unknown as Buffer };
    await expect(send(sink, broken)).resolves.toBeUndefined();
    expect(sink.stats().assetFailed).toBe(1);
    expect(store.puts).toHaveLength(0);
    warn.mockRestore();
  });

  it('types the PREFIX only: a GIF89a polyglot is stored as a gif (documented, not accidental)', async () => {
    const polyglot = Buffer.from('GIF89a/*<script>alert(1)</script>*/', 'binary');
    await send(sink, asset(polyglot));
    expect(store.puts[0].opts.contentType).toBe('image/gif');
    expect(store.puts[0].key.endsWith('.gif')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The admission queue: the sink owns a bounded worker pool so a crawl wave can
// never put an unbounded number of store ops in flight, and so the op budget
// measures the UPLOAD rather than the wait for a slot.
// ---------------------------------------------------------------------------

/**
 * A store whose PUTs PARK until the test releases them. Parking (rather than
 * delaying) is what makes the concurrency bound observable: the number of open
 * PUTs at any instant is exactly the number of workers the sink is running.
 */
class GatedObjectStore implements ObjectStore {
  readonly keys: string[] = [];
  readonly bodies: Buffer[] = [];
  readonly parked: Array<() => void> = [];
  maxParked = 0;
  existing = new Set<string>();
  /** When set, a PUT resolves after this many ms instead of parking. */
  putMs = 0;

  async exists(key: string): Promise<boolean> {
    return this.existing.has(key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.keys.push(key);
    this.bodies.push(body);
    if (this.putMs) {
      await new Promise(r => setTimeout(r, this.putMs));
      return;
    }
    await new Promise<void>(resolve => {
      this.parked.push(resolve);
      this.maxParked = Math.max(this.maxParked, this.parked.length);
    });
  }

  /** Let every currently-parked PUT complete. */
  release(): void {
    this.parked.splice(0).forEach(r => r());
  }
}

/** One turn of the event loop, including the threadpool work async gzip does. */
const tick = () => new Promise(r => setImmediate(r));

/** Spin the loop until `cond` holds (or we give up), without a fixed sleep. */
const until = async (cond: () => boolean, turns = 500): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    if (cond()) return;
    await tick();
  }
};

/** Release parked PUTs until the sink's queue is empty. */
const drain = async (store: GatedObjectStore, sink: ObjectStoreCaptureSink): Promise<void> => {
  const done = sink.flush();
  for (let i = 0; i < 500; i += 1) {
    const s = sink.stats();
    if (s.queued === 0 && s.inFlight === 0) break;
    store.release();
    await tick();
  }
  await done;
};

/** N captures with DISTINCT bytes, so none of them dedups against another. */
const distinct = (n: number) =>
  Array.from({ length: n }, (_, i) => cap({ bytes: Buffer.from(`<html>${i}</html>`, 'utf8') }));

describe('ObjectStoreCaptureSink — bounded admission queue', () => {
  it('never runs more store ops at once than RAW_STORE_CONCURRENCY', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60_000, concurrency: 2 });

    for (const c of distinct(10)) await sink.capture(c);
    await until(() => store.parked.length === 2);

    expect(store.parked.length).toBe(2);
    expect(sink.stats().inFlight).toBe(2);
    expect(sink.stats().queued).toBe(8);

    await drain(store, sink);
    expect(store.maxParked).toBe(2);
    expect(sink.stats().stored).toBe(10);
  });

  it('defaults the bound to 4 when concurrency is unset or nonsense', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60_000, concurrency: 0 });

    for (const c of distinct(10)) await sink.capture(c);
    await until(() => store.parked.length === 4);

    expect(store.parked.length).toBe(4);
    await drain(store, sink);
    expect(store.maxParked).toBe(4);
  });

  it('drops — and counts — a capture offered when the queue is already at queueMax', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 3,
    });

    // One capture is taken straight to a worker; three fill the queue; the rest drop.
    for (const c of distinct(10)) await sink.capture(c);

    expect(sink.stats().queued).toBe(3);
    expect(sink.stats().dropped).toBe(6);
    // Dropping is loud, but only once a minute — a wave must not become a log flood.
    const dropLogs = warn.mock.calls.filter(a => String(a[0]).includes('capture queue full'));
    expect(dropLogs).toHaveLength(1);

    await drain(store, sink);
    expect(sink.stats().stored).toBe(4); // exactly what was admitted
    warn.mockRestore();
  });

  it('logs a queue-full drop at most once a minute', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 1,
    });
    const dropLogs = () => warn.mock.calls.filter(a => String(a[0]).includes('capture queue full')).length;

    for (const c of distinct(4)) await sink.capture(c); // 1 running + 1 queued + 2 dropped
    expect(dropLogs()).toBe(1);

    now += 30_000;
    for (const c of distinct(2)) await sink.capture(c);
    expect(dropLogs()).toBe(1); // still inside the same minute

    now += 31_000;
    for (const c of distinct(2)) await sink.capture(c);
    expect(dropLogs()).toBe(2);

    clock.mockRestore();
    await drain(store, sink);
    warn.mockRestore();
  });

  it('times only the upload: a long queue wait never trips the op budget', async () => {
    const store = new GatedObjectStore();
    store.putMs = 20; // each upload is comfortably inside the 60ms budget
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60, concurrency: 1, queueMax: 100,
    });

    // 10 serialized 20ms uploads = ~200ms of wall clock, far beyond the 60ms
    // per-op budget. Under the old timer (started at capture time) the tail of
    // this batch would have been counted as timeouts and silently lost.
    for (const c of distinct(10)) await sink.capture(c);
    await sink.flush();

    expect(sink.stats().stored).toBe(10);
    expect(sink.stats().failed).toBe(0);
    expect(sink.stats().queueWaitP95).toBeGreaterThan(60);
    expect(sink.stats().putP95).toBeLessThan(60);
  });

  it('reports queue wait and upload time separately on the stats', async () => {
    const store = new GatedObjectStore();
    store.putMs = 5;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000, concurrency: 1 });

    for (const c of distinct(4)) await sink.capture(c);
    await sink.flush();

    const s = sink.stats();
    expect(s).toMatchObject({ queued: 0, inFlight: 0, dropped: 0, stored: 4 });
    expect(s.putP50).toBeGreaterThanOrEqual(0);
    expect(s.putP95).toBeGreaterThanOrEqual(s.putP50);
    expect(s.queueWaitP95).toBeGreaterThanOrEqual(s.queueWaitP50);
  });

  it('admits without blocking the caller: capture() resolves while the PUT is still open', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60_000, concurrency: 1 });

    await expect(sink.capture(cap())).resolves.toBeUndefined();
    await until(() => store.parked.length === 1);

    expect(store.parked.length).toBe(1); // the upload is still in flight…
    expect(sink.stats().stored).toBe(0); // …and nothing has been counted yet

    await drain(store, sink);
    expect(sink.stats().stored).toBe(1);
  });

  it('keeps the best-effort contract: a failing store never rejects out of capture()', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const boom: ObjectStore = {
      async exists() { return false; },
      async put() { throw new Error('simulated store failure'); },
    };
    const sink = new ObjectStoreCaptureSink(boom, { ...CONFIG, concurrency: 2 });

    await expect(sink.capture(cap())).resolves.toBeUndefined();
    await sink.flush();

    expect(sink.stats().failed).toBe(1);
    warn.mockRestore();
  });

  it('gzips off the event loop and stores exactly the bytes gzipSync would have', async () => {
    const store = new GatedObjectStore();
    store.putMs = 1;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000 });

    await sink.capture(cap());
    await sink.flush();

    const body = store.bodies[0];
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // a real gzip member
    expect(gunzipSync(body).equals(HTML)).toBe(true);
    // Same content the synchronous path produced — the only permitted difference
    // is in the header (mtime/OS), so the comparison is on the decompressed bytes.
    expect(gunzipSync(body).equals(gunzipSync(gzipSync(HTML)))).toBe(true);
  });

  it('shares one queue and one bound across the page and asset lanes', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, imagePrefix: 'raw-img/', putTimeoutMs: 60_000, imagePutTimeoutMs: 60_000, concurrency: 2,
    });

    for (const c of distinct(3)) await sink.capture(c);
    for (let i = 0; i < 3; i += 1) {
      await sink.capture(asset(Buffer.concat([PNG, Buffer.from([i])])));
    }

    await until(() => store.parked.length === 2);
    expect(sink.stats().inFlight).toBe(2);
    expect(sink.stats().queued).toBe(4); // both lanes waiting in the SAME queue

    await drain(store, sink);
    expect(store.maxParked).toBe(2);
    expect(sink.stats().stored).toBe(3);
    expect(sink.stats().assetStored).toBe(3);
    expect(store.keys.filter(k => k.startsWith('raw-img/'))).toHaveLength(3);
  });

  it('counts asset-lane skips at admission — a skip costs no queue slot', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, concurrency: 1 });

    await sink.capture(asset(Buffer.from('<!doctype html>not an image', 'utf8')));
    await sink.capture(asset(Buffer.alloc(0)));

    // Synchronously true, with no drain: these decisions need no store round trip.
    expect(sink.stats().assetSkipped.notImage).toBe(1);
    expect(sink.stats().assetSkipped.empty).toBe(1);
    expect(sink.stats().queued).toBe(0);
    expect(sink.stats().inFlight).toBe(0);
  });

  it('counts a disabled lane at admission without queueing anything', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, pagesEnabled: false, assetsEnabled: false, concurrency: 1,
    });

    await sink.capture(cap());
    await sink.capture(asset(PNG));

    expect(sink.stats()).toMatchObject({ skippedDisabled: 1, queued: 0, inFlight: 0 });
    expect(sink.stats().assetSkipped.disabled).toBe(1);
    expect(store.keys).toHaveLength(0);
  });

  it('clamps a runaway concurrency so a typo cannot restore the unbounded fan-out', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60_000, concurrency: 1000 });

    for (const c of distinct(70)) await sink.capture(c);
    await until(() => store.parked.length === 64);

    expect(store.parked.length).toBe(64);
    await drain(store, sink);
    expect(store.maxParked).toBe(64);
  });

  it('flush() resolves immediately when nothing is queued', async () => {
    const sink = new ObjectStoreCaptureSink(new GatedObjectStore(), CONFIG);
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
