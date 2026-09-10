import { jest } from '@jest/globals';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildRawCapture, type RawCapture } from '../../services/captureSink';
import {
  ObjectStoreCaptureSink,
  DEFAULT_PUT_TIMEOUT_MS,
  DEFAULT_IMAGE_PUT_TIMEOUT_MS,
  DEFAULT_RAW_STORE_ASSET_MAX_WAIT_MS,
  MIN_RAW_STORE_ASSET_MAX_WAIT_MS,
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
  existsDelayMs = 0;
  failPut = false;
  hangPut = false;
  hangExists = false;

  async exists(key: string): Promise<boolean> {
    this.headCalls += 1;
    if (this.hangExists) return new Promise<boolean>(() => {}); // never resolves
    if (this.existsDelayMs) await new Promise(r => setTimeout(r, this.existsDelayMs));
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
      // The queue's own view, drained: nothing waiting in either lane, nothing running, nothing lost.
      queued: 0,
      queuedPages: 0,
      queuedAssets: 0,
      inFlight: 0,
      dropped: 0,
      droppedBytes: 0,
      assetRefusedReserve: 0,
      assetRefusedReserveDepth: 0,
      assetRefusedReserveBytes: 0,
      queuedBytes: 0,
      // Latencies are wall clock, so the SHAPE is asserted and the values are not:
      // a real HEAD that happens to cross a millisecond boundary is not a defect.
      queueWaitP50: expect.any(Number),
      queueWaitP95: expect.any(Number),
      putP50: expect.any(Number),
      putP95: expect.any(Number),
      headP50: expect.any(Number),
      headP95: expect.any(Number),
      // Nothing overran its budget, and the lag reading is this process's own
      // scheduling delay — the number that says whether a slow putP95 is the store
      // or this pod.
      timedOut: 0,
      eventLoopLagP50: expect.any(Number),
      eventLoopLagP95: expect.any(Number),
      eventLoopLagMax: expect.any(Number),
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
  /** When true a PUT stops parking and resolves at once — the cheap way to drain deep queues. */
  open = false;

  async exists(key: string): Promise<boolean> {
    return this.existing.has(key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.keys.push(key);
    this.bodies.push(body);
    // The real bucket is write-once and content-addressed: once written, the key
    // exists and a later HEAD for the same content is a dedup hit.
    this.existing.add(key);
    if (this.open) return;
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

/**
 * Spin the loop until `cond` holds (or we give up), without a fixed sleep. The budget
 * is generous because gzip runs on libuv's 4-thread pool: filling a 64-deep worker
 * set means 64 compressions, and on a contended CI runner those need far more than a
 * few hundred turns. The loop exits the moment the condition holds, so a large budget
 * costs a passing test nothing.
 */
const until = async (cond: () => boolean, turns = 20_000): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    if (cond()) return;
    await tick();
  }
};

/** Release parked PUTs until the sink's queue is empty. */
const drain = async (store: GatedObjectStore, sink: ObjectStoreCaptureSink): Promise<void> => {
  const done = sink.flush();
  for (let i = 0; i < 5000; i += 1) {
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
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60, concurrency: 1, queueMax: 100,
    });
    let now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);

    // Park the worker so the rest genuinely queue behind it, then advance the clock
    // by five minutes: five thousand times the op budget, spent entirely in the
    // queue. Under the old timer — armed when the capture was offered — every one of
    // these would have been abandoned as a store timeout and silently lost.
    await sink.capture(cap({ bytes: Buffer.from('first', 'utf8') }));
    await until(() => store.parked.length === 1);
    for (const c of distinct(5)) await sink.capture(c);
    now += 5 * 60_000;

    store.open = true;
    store.release();
    await sink.flush();

    expect(sink.stats().queueWaitP95).toBeGreaterThan(60);
    expect(sink.stats().failed).toBe(0);
    expect(sink.stats().stored).toBe(6);
    clock.mockRestore();
  });

  it('samples a PUT that TIMED OUT, so a failing lane cannot hide behind a fast p95', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new FakeObjectStore();
    store.hangPut = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60 });

    await sink.capture(cap());
    await sink.flush();

    expect(sink.stats().failed).toBe(1);
    // The op that consumed the whole budget is the one an operator most needs in
    // the percentile; sampling successes only makes a dying lane look healthy.
    expect(sink.stats().putP95).toBeGreaterThanOrEqual(50);
    warn.mockRestore();
  });

  it('times the HEAD as well as the PUT', async () => {
    const store = new FakeObjectStore();
    store.existsDelayMs = 25;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000 });

    await sink.capture(cap());
    await sink.flush();

    // HEAD is half the round trips this sink makes; leaving it untimed hid half the
    // latency, and a dedup hit is nothing BUT a HEAD.
    expect(sink.stats().headP95).toBeGreaterThanOrEqual(20);
    expect(sink.stats().headP50).toBeGreaterThanOrEqual(20);
  });

  it('samples the HEAD on a dedup hit, where there is no PUT to measure', async () => {
    const store = new FakeObjectStore();
    store.existsDelayMs = 25;
    const c = cap();
    store.existing.add(`raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`);
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000 });

    await sink.capture(c);
    await sink.flush();

    expect(sink.stats().deduped).toBe(1);
    expect(sink.stats().headP95).toBeGreaterThanOrEqual(20);
    expect(sink.stats().putP95).toBe(0); // no upload happened, so nothing to report
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

    await expect(sink.capture(cap())).resolves.toEqual({ admitted: true });
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

    // Admitted, then the store blew up on the worker: the failure is counted, never thrown.
    await expect(sink.capture(cap())).resolves.toEqual({ admitted: true });
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

  it('drops on the BYTE ceiling long before the count ceiling is reached', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 100, queueMaxBytes: 1000,
    });

    // 400-byte bodies: one goes straight to the worker, two fit the 1000-byte
    // budget, the fourth would put the queue over it. The count ceiling (100) is
    // nowhere near — a queue of 10 MiB assets exhausts memory at a depth the
    // count alone calls healthy.
    for (let i = 0; i < 4; i += 1) await sink.capture(cap({ bytes: Buffer.alloc(400, i) }));

    expect(sink.stats().queued).toBe(2);
    expect(sink.stats().queuedBytes).toBe(800);
    expect(sink.stats().droppedBytes).toBe(1);
    expect(sink.stats().dropped).toBe(0); // the COUNT ceiling was never the binding one

    await drain(store, sink);
    warn.mockRestore();
  });

  it('counts the two ceilings separately so an operator knows which one bound', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 2, queueMaxBytes: 10_000,
    });

    // Small bodies, so only the count ceiling can bind: 1 running + 2 queued + 2 dropped.
    for (let i = 0; i < 5; i += 1) await sink.capture(cap({ bytes: Buffer.alloc(10, i) }));

    expect(sink.stats().dropped).toBe(2);
    expect(sink.stats().droppedBytes).toBe(0);

    await drain(store, sink);
    warn.mockRestore();
  });

  it('releases the byte budget as the queue drains', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 100, queueMaxBytes: 1000,
    });

    for (let i = 0; i < 3; i += 1) await sink.capture(cap({ bytes: Buffer.alloc(400, i) }));
    expect(sink.stats().queuedBytes).toBe(800);

    await drain(store, sink);
    expect(sink.stats().queuedBytes).toBe(0);

    // The budget is a live ceiling, not a lifetime one: capture works again.
    await sink.capture(cap({ bytes: Buffer.alloc(400, 9) }));
    expect(sink.stats().droppedBytes).toBe(0);
    await drain(store, sink);
    expect(sink.stats().stored).toBe(4);
  });

  it('defaults the byte ceiling to 256 MiB when unset or nonsense', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60_000, queueMaxBytes: 0 });
    // 1 MiB queued against the default budget is nowhere near it.
    await sink.capture(cap({ bytes: Buffer.alloc(1024 * 1024, 1) }));
    expect(sink.stats().droppedBytes).toBe(0);
    await drain(store, sink);
  });

  it('clamps a runaway queueMax so the count ceiling stays a real bound', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 10_000, queueMaxBytes: 1024 * 1024 * 1024,
    });

    // 1 running + 5000 queued (the clamp) + 1 dropped.
    for (let i = 0; i < 5002; i += 1) await sink.capture(cap({ bytes: Buffer.from(`b${i}`) }));

    expect(sink.stats().queued).toBe(5000);
    expect(sink.stats().dropped).toBe(1);

    // Drain by opening the store rather than releasing 5000 parked PUTs one tick at
    // a time — a backlog left running would starve the next test's event loop.
    store.open = true;
    store.release();
    await sink.flush();
    expect(sink.stats().queued).toBe(0);
    warn.mockRestore();
  });

  it('tells the caller a dropped capture was NOT admitted, and why', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 1,
    });

    await expect(sink.capture(cap({ bytes: Buffer.from('a') }))).resolves.toEqual({ admitted: true });
    await expect(sink.capture(cap({ bytes: Buffer.from('b') }))).resolves.toEqual({ admitted: true });
    // Third one: the queue is full. Silence here is what let the image hook count a
    // dropped capture as stored and memoize the url, suppressing its own retry.
    await expect(sink.capture(cap({ bytes: Buffer.from('c') }))).resolves.toEqual({
      admitted: false, reason: 'queueFull',
    });

    store.open = true;
    store.release();
    await sink.flush();
    warn.mockRestore();
  });

  it('names the BYTE ceiling as the reason when that is the one that bound', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, putTimeoutMs: 60_000, concurrency: 1, queueMax: 100, queueMaxBytes: 500,
    });

    await sink.capture(cap({ bytes: Buffer.alloc(400, 1) })); // straight to the worker
    await sink.capture(cap({ bytes: Buffer.alloc(400, 2) })); // queued, 400 of 500
    await expect(sink.capture(cap({ bytes: Buffer.alloc(400, 3) }))).resolves.toEqual({
      admitted: false, reason: 'queueBytesFull',
    });

    store.open = true;
    store.release();
    await sink.flush();
    warn.mockRestore();
  });

  it('treats a typed skip and a disabled lane as ADMITTED — decisions, not refusals', async () => {
    const store = new GatedObjectStore();
    store.open = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, concurrency: 1 });

    // The sink resolved these captures. Re-offering them changes nothing, so they
    // must NOT read as "try again" — only a full queue means that.
    await expect(sink.capture(asset(Buffer.from('<html>nope</html>')))).resolves.toEqual({ admitted: true });
    const off = new ObjectStoreCaptureSink(store, { ...CONFIG, pagesEnabled: false, assetsEnabled: false });
    await expect(off.capture(cap())).resolves.toEqual({ admitted: true });
    await expect(off.capture(asset(PNG))).resolves.toEqual({ admitted: true });
    await sink.flush();
  });

  it('does not race the same content address into two PUTs', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 60_000, concurrency: 2 });

    // Identical bytes → identical key. The HEAD-then-PUT dedup is blind to a sibling
    // op: both workers HEAD before either PUT lands, both miss, and the "write-once"
    // contract becomes two uploads of the same object.
    await sink.capture(cap());
    await sink.capture(cap());
    await until(() => store.parked.length === 1);

    expect(store.keys).toHaveLength(1);
    expect(sink.stats().deduped).toBe(1);

    store.open = true;
    store.release();
    await sink.flush();
    expect(sink.stats().stored).toBe(1);
    expect(store.keys).toHaveLength(1);
  });

  it('applies the in-flight guard to the asset lane on the same key space', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, imagePrefix: 'raw-img/', imagePutTimeoutMs: 60_000, concurrency: 2,
    });

    await sink.capture(asset(PNG));
    await sink.capture(asset(PNG));
    await until(() => store.parked.length === 1);

    expect(store.keys).toHaveLength(1);
    expect(sink.stats().assetDeduped).toBe(1);

    store.open = true;
    store.release();
    await sink.flush();
    expect(sink.stats().assetStored).toBe(1);
  });

  it('releases the in-flight key when the op finishes, so a later capture still dedups', async () => {
    const store = new GatedObjectStore();
    store.open = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000, concurrency: 2 });

    await sink.capture(cap());
    await sink.flush();
    // The guard is for CONCURRENT ops only; the store's own HEAD answers the rest.
    await sink.capture(cap());
    await sink.flush();

    expect(sink.stats()).toMatchObject({ stored: 1, deduped: 1 });
    expect(store.keys).toHaveLength(1);
  });

  it('flush() resolves immediately when nothing is queued', async () => {
    const sink = new ObjectStoreCaptureSink(new GatedObjectStore(), CONFIG);
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The page reservation: one queue, two lanes with very different stakes. A page
// body is provenance behind a claim already written to the spine and nothing
// will ever fetch it again; an image is re-fetchable on the next crawl pass.
// ---------------------------------------------------------------------------

/** N asset captures with DISTINCT image bytes (so none dedups), each exactly `size` bytes. */
const assets = (n: number, size = PNG.length + 1) =>
  Array.from({ length: n }, (_, i) =>
    asset(Buffer.concat([PNG, Buffer.alloc(Math.max(1, size - PNG.length), i + 1)])),
  );

/** N page captures with DISTINCT bodies, each exactly `size` bytes. */
const pages = (n: number, size = 16) =>
  Array.from({ length: n }, (_, i) => cap({ bytes: Buffer.alloc(size, 0x61 + i) }));

/** A sink whose single worker is already parked on a store op, so everything else queues. */
const parkedSink = async (
  store: GatedObjectStore,
  over: Partial<RawStoreConfig>,
): Promise<ObjectStoreCaptureSink> => {
  const sink = new ObjectStoreCaptureSink(store, {
    ...CONFIG,
    imagePrefix: 'raw-img/',
    putTimeoutMs: 60_000,
    imagePutTimeoutMs: 60_000,
    concurrency: 1,
    ...over,
  });
  await sink.capture(cap({ bytes: Buffer.from('<html>worker</html>', 'utf8') }));
  await until(() => store.parked.length === 1);
  return sink;
};

describe('ObjectStoreCaptureSink — the asset lane cannot evict the page lanes', () => {
  const release = async (store: GatedObjectStore, sink: ObjectStoreCaptureSink): Promise<void> => {
    store.open = true;
    store.release();
    await sink.flush();
  };

  it('stops admitting assets at their share of the DEPTH while pages keep the rest', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 4, assetQueueShare: 0.5 });

    const [a1, a2, a3] = assets(3);
    await expect(sink.capture(a1)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(a2)).resolves.toEqual({ admitted: true });
    // Half of four slots is the asset share, and it is now spent — even though the
    // queue is only half full. That other half is not first-come-first-served.
    await expect(sink.capture(a3)).resolves.toEqual({ admitted: false, reason: 'assetReserve' });

    // ...and a page walks straight into the space the reservation just held.
    const [p1, p2, p3] = pages(3);
    await expect(sink.capture(p1)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(p2)).resolves.toEqual({ admitted: true });
    // Only now, with the whole depth spent, does a PAGE drop — and it is counted as one.
    await expect(sink.capture(p3)).resolves.toEqual({ admitted: false, reason: 'queueFull' });

    expect(sink.stats()).toMatchObject({
      queued: 4, assetRefusedReserve: 1, assetRefusedReserveDepth: 1, assetRefusedReserveBytes: 0, dropped: 1, droppedBytes: 0,
    });

    await release(store, sink);
    warn.mockRestore();
  });

  it('stops admitting assets at their share of the BYTE budget while pages keep the rest', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    // Depth is nowhere near binding: only the byte share can decide this.
    const sink = await parkedSink(store, { queueMax: 100, queueMaxBytes: 1000, assetQueueShare: 0.5 });

    const [a1, a2] = assets(2, 300);
    // Nothing is waiting yet, so the first asset displaces nobody and goes in.
    await expect(sink.capture(a1)).resolves.toEqual({ admitted: true });
    // The SECOND is refused, not the third: the share counts what the queue WOULD hold
    // (300 + 300 > 500), because one asset is a variable and possibly enormous number of
    // bytes where one slot is only ever one slot. Measured on occupancy alone this asset
    // was admitted instead and the budget then stood at 600 of 1000, reserve gone.
    await expect(sink.capture(a2)).resolves.toEqual({ admitted: false, reason: 'assetReserve' });

    await expect(sink.capture(pages(1, 300)[0])).resolves.toEqual({ admitted: true });

    expect(sink.stats()).toMatchObject({
      queued: 2, queuedBytes: 600, assetRefusedReserve: 1, assetRefusedReserveDepth: 0, assetRefusedReserveBytes: 1,
      dropped: 0, droppedBytes: 0,
    });

    await release(store, sink);
    warn.mockRestore();
  });

  it('never lets assets walk the byte budget past their share and refuse a PAGE', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    // A legal configuration: RAW_STORE_IMAGE_MAX_BYTES can be set as high as 64 MiB,
    // which is EXACTLY the quarter of the 256 MiB default budget the reservation is
    // meant to hold. Scaled down here by 1000, one asset is a quarter of the budget.
    const sink = await parkedSink(store, { queueMax: 100, queueMaxBytes: 256_000, maxImageBytes: 64_000 });

    // The walk that emptied the reserve at that configuration: 63999 + 64000 + 64000 all
    // landed while the queue was still short of the 192000 share line.
    await expect(sink.capture(assets(1, 63_999)[0])).resolves.toEqual({ admitted: true });
    const [a2, a3, a4] = assets(3, 64_000);
    for (const a of [a2, a3]) await expect(sink.capture(a)).resolves.toEqual({ admitted: true });
    expect(sink.stats().queuedBytes).toBe(191_999); // a single byte under the share line

    // Admitting on occupancy alone, this asset was let in BECAUSE the queue had not
    // yet crossed the line — and it took the queue to 255999 of 256000, spending the
    // pages' whole reserve on one image. The share has to be tested against what the
    // queue WOULD hold, not what it holds.
    await expect(sink.capture(a4)).resolves.toEqual({ admitted: false, reason: 'assetReserve' });

    // The page the reserve exists for. This is the assertion the old rule failed:
    // it was refused queueBytesFull with the byte budget spent entirely on images.
    await expect(sink.capture(pages(1, 100)[0])).resolves.toEqual({ admitted: true });

    expect(sink.stats()).toMatchObject({
      droppedBytes: 0, assetRefusedReserve: 1, assetRefusedReserveBytes: 1, queuedBytes: 192_099,
    });

    await release(store, sink);
    warn.mockRestore();
  });

  it('reserves 3 of 4 slots for pages by default — the share defaults to 0.75', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 4 }); // no assetQueueShare configured

    const [a1, a2, a3, a4] = assets(4);
    for (const a of [a1, a2, a3]) await expect(sink.capture(a)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(a4)).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    // The last slot is the pages', and it is still there.
    await expect(sink.capture(pages(1)[0])).resolves.toEqual({ admitted: true });

    expect(sink.stats()).toMatchObject({ queued: 4, assetRefusedReserve: 1, dropped: 0 });

    await release(store, sink);
    warn.mockRestore();
  });

  it('a share of 1 turns the reservation OFF — both lanes share the whole budget as before', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 2, assetQueueShare: 1 });

    const [a1, a2, a3] = assets(3);
    await expect(sink.capture(a1)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(a2)).resolves.toEqual({ admitted: true });
    // First-come-first-served again: the asset is refused by the DEPTH ceiling, with
    // the ceiling's own reason and the ceiling's own counter.
    await expect(sink.capture(a3)).resolves.toEqual({ admitted: false, reason: 'queueFull' });

    expect(sink.stats()).toMatchObject({ dropped: 1, assetRefusedReserve: 0 });

    await release(store, sink);
    warn.mockRestore();
  });

  it('clamps a nonsense share: above 1 is no reservation, at-or-below 0 is the default', async () => {
    const store = new GatedObjectStore();
    const wide = await parkedSink(store, { queueMax: 2, assetQueueShare: 5 });
    for (const a of assets(2)) await expect(wide.capture(a)).resolves.toEqual({ admitted: true });
    expect(wide.stats()).toMatchObject({ queued: 2, assetRefusedReserve: 0 });

    const store2 = new GatedObjectStore();
    const negative = await parkedSink(store2, { queueMax: 4, assetQueueShare: -1 });
    for (const a of assets(3)) await expect(negative.capture(a)).resolves.toEqual({ admitted: true });
    // Back to the 0.75 default: the fourth asset is held, not the fourth slot's page.
    await expect(negative.capture(assets(4)[3])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await release(store, wide);
    await release(store2, negative);
    warn.mockRestore();
  });

  it('reports held-back assets on their own line, apart from page drops, once a minute', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 2, assetQueueShare: 0.5 });

    const lines = (needle: string) => warn.mock.calls.filter(a => String(a[0]).includes(needle));
    const heldLines = () => lines('held back for the page reservation');
    const dropLines = () => lines('capture queue full');

    await sink.capture(assets(1)[0]); // fills the assets' single slot
    for (const a of assets(3)) await sink.capture(a); // all three held back
    // The first refusal is reported at once; the rest of the burst is carried to the
    // next report rather than becoming a log flood, exactly as a drop burst is.
    expect(heldLines()).toHaveLength(1);
    expect(String(heldLines()[0][0])).toContain('refused 1 asset capture(s) since the last report');
    expect(dropLines()).toHaveLength(0); // nothing was DROPPED — the queue is not full

    // A page drop is a different event with its own line and its own window.
    await sink.capture(pages(1)[0]); // takes the last slot
    await sink.capture(pages(2)[1]); // and now the queue really is full
    expect(dropLines()).toHaveLength(1);
    expect(String(dropLines()[0][0])).toContain('dropped 1 capture(s) since the last report');
    expect(heldLines()).toHaveLength(1);

    now += 61_000;
    await sink.capture(assets(1)[0]);
    expect(heldLines()).toHaveLength(2);
    // The two suppressed refusals plus this one — the burst is reported, not lost.
    expect(String(heldLines()[1][0])).toContain('refused 3 asset capture(s) since the last report');
    expect(sink.stats().assetRefusedReserve).toBe(4);

    clock.mockRestore();
    await release(store, sink);
    warn.mockRestore();
  });

  it('holds nothing back on an EMPTY queue — one asset can always get in', async () => {
    const store = new GatedObjectStore();
    store.open = true;
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, imagePrefix: 'raw-img/', concurrency: 1, queueMax: 1, assetQueueShare: 0.1,
    });

    // 0.1 of a 1-deep queue rounds to nothing, but the queue is empty: the capture
    // goes straight to a worker and displaces no page.
    await expect(sink.capture(asset(PNG))).resolves.toEqual({ admitted: true });
    await sink.flush();
    expect(sink.stats()).toMatchObject({ assetStored: 1, assetRefusedReserve: 0 });
  });

  it('admits an asset that alone exceeds the BYTE share when nothing is waiting behind it', async () => {
    const store = new GatedObjectStore();
    const parked = await parkedSink(store, { queueMax: 100, queueMaxBytes: 1000, assetQueueShare: 0.1 });

    // 300 bytes against a 100-byte share. The queue is empty, so this asset displaces
    // no page — and only one can ever be held that way, because the next asset is
    // measured against the bytes this one is holding.
    await expect(parked.capture(assets(1, 300)[0])).resolves.toEqual({ admitted: true });
    await expect(parked.capture(assets(2, 300)[1])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    // The hard ceiling is still the hard ceiling: a page can have the rest, no more.
    await expect(parked.capture(pages(1, 300)[0])).resolves.toEqual({ admitted: true });
    expect(parked.stats()).toMatchObject({ queuedBytes: 600, assetRefusedReserve: 1, droppedBytes: 0 });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    store.open = true;
    store.release();
    await parked.flush();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Page PRIORITY. The reservation buys a page ADMISSION; it says nothing about when
// the page reaches the bucket. Drained first-come-first-served, a page admitted into
// the reserved tail sat behind every asset queued before it — minutes of 10 MiB
// uploads at prod scale — and at SIGTERM the bounded flush spent its whole budget
// on re-fetchable images while the irreplaceable page was abandoned behind them.
// ---------------------------------------------------------------------------

const pageKey = (c: RawCapture) => `raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`;
const assetKey = (c: RawCapture) => `raw-img/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.png`;

describe('ObjectStoreCaptureSink — pages reach a worker before assets', () => {
  it('takes every waiting PAGE before any waiting asset, FIFO within each lane', async () => {
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 100 });

    const [a1, a2, a3, a4] = assets(4);
    const [p1, p2, p3] = pages(3);
    // The shape of a crawl pass: an item's images queue up before the next item's page lands.
    for (const c of [a1, a2, a3, p1, p2, a4, p3]) {
      await expect(sink.capture(c)).resolves.toEqual({ admitted: true });
    }
    expect(sink.stats()).toMatchObject({ queued: 7, queuedPages: 3, queuedAssets: 4, inFlight: 1 });

    store.open = true;
    store.release();
    await sink.flush();

    // After the parked worker's own page: the pages in arrival order, THEN the assets in
    // theirs. p3 arrived last of all and still reaches the bucket before a1, which arrived first.
    expect(store.keys.slice(1)).toEqual([...[p1, p2, p3].map(pageKey), ...[a1, a2, a3, a4].map(assetKey)]);
  });

  it('a page admitted behind a deep asset backlog is the NEXT thing a freed worker takes', async () => {
    const store = new GatedObjectStore();
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, imagePrefix: 'raw-img/', putTimeoutMs: 60_000, imagePutTimeoutMs: 60_000, concurrency: 2, queueMax: 100,
    });
    const backlog = assets(10);
    for (const a of backlog) await expect(sink.capture(a)).resolves.toEqual({ admitted: true });
    await until(() => store.parked.length === 2);
    const [p1] = pages(1);
    await expect(sink.capture(p1)).resolves.toEqual({ admitted: true });
    expect(sink.stats()).toMatchObject({ queued: 9, inFlight: 2 });

    // One upload finishes. Eight assets have been waiting longer than the page; the
    // worker takes the page. Its wait was ONE upload, not the backlog.
    store.parked.splice(0, 1).forEach(r => r());
    await until(() => store.keys.length === 3);
    expect(store.keys[2]).toBe(pageKey(p1));
    expect(store.keys.slice(0, 2)).toEqual(backlog.slice(0, 2).map(assetKey));

    await drain(store, sink);
    expect(sink.stats()).toMatchObject({ stored: 1, assetStored: 10 });
  });

  it('bounds the asset lane at its share of the WAITING queue plus one upload per worker — a page waits behind at most that one upload', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    // The share defaults to 0.75, so the line is six of eight slots. Eight workers.
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG, imagePrefix: 'raw-img/', putTimeoutMs: 60_000, imagePutTimeoutMs: 60_000, concurrency: 8, queueMax: 8,
    });
    const all = assets(16);

    // Every worker is idle, so the first eight go straight to one and WAIT for nobody —
    // the seventh and eighth included, offered with the line at six. The share is a share
    // of the queue, and an upload that is running holds no slot in it: an empty queue
    // admits an asset however many images are uploading. (Counting the uploads against
    // the share instead refuses that seventh asset with the queue empty and two workers
    // idle — the lane throttled by a knob that is not the concurrency knob.)
    for (const a of all.slice(0, 8)) await expect(sink.capture(a)).resolves.toEqual({ admitted: true });
    await until(() => store.parked.length === 8);
    expect(sink.stats()).toMatchObject({ queued: 0, inFlight: 8 });

    // Now the queue fills: six waiting is the share, the seventh is held.
    for (const a of all.slice(8, 14)) await expect(sink.capture(a)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(all[14])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    // So the lane's whole footprint is share × queueMax WAITING plus concurrency RUNNING:
    // fourteen of the sixteen offered, never six. That is the number an operator sizing
    // memory has to use, and it is the number the header and the README state.
    expect(sink.stats()).toMatchObject({ queued: 6, inFlight: 8, assetRefusedReserve: 1, assetRefusedReserveDepth: 1 });

    // None of it touched the pages' two slots.
    const [p1, p2, p3] = pages(3);
    await expect(sink.capture(p1)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(p2)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(p3)).resolves.toEqual({ admitted: false, reason: 'queueFull' });

    // And the running uploads are the ONLY thing a page ever waits behind: the moment one
    // finishes, its worker takes the page — not one of the six assets queued ahead of it.
    store.parked.splice(0, 1).forEach(r => r());
    await until(() => store.keys.length === 9);
    expect(store.keys[8]).toBe(pageKey(p1));

    await drain(store, sink);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The hold report names its budget. `dropAndLog` already takes a `ceiling` and keeps
// `dropped` apart from `droppedBytes` so an operator can see WHICH ceiling bound —
// a depth problem and a payload problem want different settings raised. The hold
// path applied neither half of that: one counter, one line that listed both budgets.
// ---------------------------------------------------------------------------

describe('ObjectStoreCaptureSink — a held-back asset is counted against the budget that held it', () => {
  it('splits the reserve counter by budget and says which one bit in the report', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const held = () => warn.mock.calls.map(a => String(a[0])).filter(l => l.includes('held back for the page reservation'));

    // DEPTH binds: two 100-byte assets fill half of four slots with the byte budget barely touched.
    const storeA = new GatedObjectStore();
    const byDepth = await parkedSink(storeA, { queueMax: 4, queueMaxBytes: 1000, assetQueueShare: 0.5 });
    for (const a of assets(2, 100)) await expect(byDepth.capture(a)).resolves.toEqual({ admitted: true });
    await expect(byDepth.capture(assets(3, 100)[2])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    expect(byDepth.stats()).toMatchObject({
      assetRefusedReserve: 1, assetRefusedReserveDepth: 1, assetRefusedReserveBytes: 0,
    });
    expect(held()).toHaveLength(1);
    // The line names the budget AND the knob that raises it.
    expect(held()[0]).toContain('share of the queue DEPTH is spent');
    expect(held()[0]).toContain('RAW_STORE_QUEUE_MAX 4: 2 queued = 0 page(s) + 2 asset(s)');
    expect(held()[0]).toContain('1 on depth and 0 on bytes in total');
    expect(held()[0]).not.toContain('RAW_STORE_QUEUE_MAX_BYTES');

    // BYTES bind: one 300-byte asset holds 300 of a 500-byte share; the next would take it to 600.
    const storeB = new GatedObjectStore();
    const byBytes = await parkedSink(storeB, { queueMax: 100, queueMaxBytes: 1000, assetQueueShare: 0.5 });
    await expect(byBytes.capture(assets(1, 300)[0])).resolves.toEqual({ admitted: true });
    await expect(byBytes.capture(assets(2, 300)[1])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    expect(byBytes.stats()).toMatchObject({
      assetRefusedReserve: 1, assetRefusedReserveDepth: 0, assetRefusedReserveBytes: 1,
    });
    expect(held()).toHaveLength(2);
    expect(held()[1]).toContain('share of the queue BYTES is spent');
    expect(held()[1]).toContain('RAW_STORE_QUEUE_MAX_BYTES 1000: 300 queued + 300 offered, held by 0 page(s) + 1 asset(s)');
    expect(held()[1]).toContain('0 on depth and 1 on bytes in total');

    // The compatibility counter is exactly the sum, and stays so as both climb.
    await expect(byBytes.capture(assets(3, 300)[2])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    expect(byBytes.stats()).toMatchObject({ assetRefusedReserve: 2, assetRefusedReserveDepth: 0, assetRefusedReserveBytes: 2 });

    for (const [store, sink] of [[storeA, byDepth], [storeB, byBytes]] as const) {
      store.open = true;
      store.release();
      await sink.flush();
    }
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The asset lane must not starve. Strict pages-first parked the whole resident asset
// backlog for the length of a crawler burst: nothing uploaded, every new asset refused
// assetReserve, and the hold line naming RAW_STORE_QUEUE_MAX — a knob that frees nothing,
// because those captures were short of a worker, not of space. An asset that has waited
// LONGER THAN the window goes next; one of them, then a page again.
// ---------------------------------------------------------------------------

/**
 * Two assets queued, aged by `ageMs`, then three pages queued behind them; returns the order
 * the single worker takes them once its parked upload finishes (that parked page excluded).
 * `flushFirst` registers a shutdown flush before the worker is freed, as SIGTERM would.
 */
const takeOrder = async (over: Partial<RawStoreConfig>, ageMs: number, flushFirst = false): Promise<string[]> => {
  let now = 1_700_000_000_000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  const store = new GatedObjectStore();
  const sink = await parkedSink(store, { queueMax: 100, ...over });
  const [a1, a2] = assets(2);
  const [p1, p2, p3] = pages(3);
  for (const a of [a1, a2]) await expect(sink.capture(a)).resolves.toEqual({ admitted: true });
  now += ageMs;
  for (const p of [p1, p2, p3]) await expect(sink.capture(p)).resolves.toEqual({ admitted: true });
  // A flush registered BEFORE the worker is freed, or no flush at all until the queue has
  // drained on its own — a flush() call is what makes the drain a shutdown drain.
  const flushing = flushFirst ? sink.flush() : undefined;
  store.open = true;
  store.release();
  await until(() => sink.stats().queued === 0 && sink.stats().inFlight === 0);
  await flushing;
  clock.mockRestore();
  const names = new Map([
    [assetKey(a1), 'a1'], [assetKey(a2), 'a2'], [pageKey(p1), 'p1'], [pageKey(p2), 'p2'], [pageKey(p3), 'p3'],
  ]);
  return store.keys.slice(1).map(k => names.get(k) ?? k);
};

describe('ObjectStoreCaptureSink — an asset that has waited past RAW_STORE_ASSET_MAX_WAIT_MS goes next', () => {
  it('exports the window bounds: 30 s by default, never under 1 s', () => {
    expect(DEFAULT_RAW_STORE_ASSET_MAX_WAIT_MS).toBe(30_000);
    expect(MIN_RAW_STORE_ASSET_MAX_WAIT_MS).toBe(1_000);
  });

  it('takes the aged asset before the next page, then a page again — one aged asset per turn, never the backlog', async () => {
    // a2 has waited exactly as long as a1, and still p1 goes between them: the take is
    // bounded to ONE aged asset per turn, so a page burst can never flip into assets-first.
    expect(await takeOrder({ assetMaxWaitMs: 30_000 }, 30_001)).toEqual(['a1', 'p1', 'a2', 'p2', 'p3']);
  });

  it('keeps pages first while the oldest asset is inside the window — LONGER than, so the window itself is not enough', async () => {
    expect(await takeOrder({ assetMaxWaitMs: 30_000 }, 30_000)).toEqual(['p1', 'p2', 'p3', 'a1', 'a2']);
  });

  it('defaults the window to 30 s, and falls back to it on a nonsense value', async () => {
    for (const over of [{}, { assetMaxWaitMs: Number.NaN }, { assetMaxWaitMs: 0 }, { assetMaxWaitMs: -5 }]) {
      expect(await takeOrder(over, 29_999)).toEqual(['p1', 'p2', 'p3', 'a1', 'a2']);
      expect(await takeOrder(over, 30_001)).toEqual(['a1', 'p1', 'a2', 'p2', 'p3']);
    }
  });

  it('clamps the window at 1 s from below, so a typo cannot turn priority into round-robin', async () => {
    expect(await takeOrder({ assetMaxWaitMs: 5 }, 999)).toEqual(['p1', 'p2', 'p3', 'a1', 'a2']);
    expect(await takeOrder({ assetMaxWaitMs: 5 }, 1_001)).toEqual(['a1', 'p1', 'a2', 'p2', 'p3']);
  });

  it('the shutdown flush still drains pages first, however long the assets have waited', async () => {
    expect(await takeOrder({ assetMaxWaitMs: 1_000 }, 600_000, true)).toEqual(['p1', 'p2', 'p3', 'a1', 'a2']);
  });

  it('serves an asset within the window of a page burst that strict priority would have starved it through', async () => {
    let now = 1_700_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 100, assetMaxWaitMs: 30_000 });
    const [a1] = assets(1);
    await expect(sink.capture(a1)).resolves.toEqual({ admitted: true });

    // The burst: a new page lands every upload, each upload takes 5 s, and there is ALWAYS a
    // page waiting when the worker frees. Under strict priority a1 would upload only after the
    // burst ended — twelve pages, sixty seconds, for as long as the crawler kept going.
    const burst = pages(12);
    for (let round = 1; round <= 10; round += 1) {
      await expect(sink.capture(burst[round - 1])).resolves.toEqual({ admitted: true });
      now += 5_000;
      store.parked.splice(0, 1).forEach(r => r()); // the running upload finishes
      await until(() => store.parked.length === 1); // the worker took the next capture and parked on its PUT
    }
    // Rounds 1–6: pages, a1 aged 5 s … 30 s (not yet LONGER than the window). Round 7, at 35 s:
    // a1 goes next even though p7 is waiting; round 8 the worker is back on pages.
    expect(store.keys.slice(1, 7)).toEqual(burst.slice(0, 6).map(pageKey));
    expect(store.keys[7]).toBe(assetKey(a1));
    expect(store.keys[8]).toBe(pageKey(burst[6]));
    expect(sink.stats()).toMatchObject({ assetStored: 1, queuedAssets: 0 });

    clock.mockRestore();
    await drain(store, sink);
  });
});

// ---------------------------------------------------------------------------
// The queue depth by lane. `queued` alone cannot tell "375 images parked behind pages"
// from "375 pages backed up", and the DEPTH hold line could claim the asset share was
// spent while the queue held no asset at all — the share is a share of the whole queue.
// ---------------------------------------------------------------------------

describe('ObjectStoreCaptureSink — the queue depth is reported by lane', () => {
  it('reports queuedPages and queuedAssets beside their sum, live as the lanes drain', async () => {
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 100 });
    const [a1, a2] = assets(2);
    const [p1] = pages(1);
    for (const c of [a1, p1, a2]) await expect(sink.capture(c)).resolves.toEqual({ admitted: true });
    expect(sink.stats()).toMatchObject({ queued: 3, queuedPages: 1, queuedAssets: 2, inFlight: 1 });

    // The freed worker takes the page; the two assets are what is left waiting.
    store.parked.splice(0, 1).forEach(r => r());
    await until(() => store.keys.length === 2);
    expect(sink.stats()).toMatchObject({ queued: 2, queuedPages: 0, queuedAssets: 2 });

    await drain(store, sink);
    expect(sink.stats()).toMatchObject({ queued: 0, queuedPages: 0, queuedAssets: 0 });
  });

  it('names the lanes on the DEPTH hold line, so a share spent by PAGES is never read as an asset backlog', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new GatedObjectStore();
    const sink = await parkedSink(store, { queueMax: 4, assetQueueShare: 0.5 });
    // Two pages reach the asset share of the depth with no asset waiting at all.
    for (const p of pages(2)) await expect(sink.capture(p)).resolves.toEqual({ admitted: true });
    await expect(sink.capture(assets(1)[0])).resolves.toEqual({ admitted: false, reason: 'assetReserve' });
    expect(sink.stats()).toMatchObject({ queued: 2, queuedPages: 2, queuedAssets: 0, assetRefusedReserveDepth: 1 });
    const line = warn.mock.calls.map(a => String(a[0])).find(l => l.includes('held back for the page reservation'));
    expect(line).toContain('2 queued = 2 page(s) + 0 asset(s)');

    store.open = true;
    store.release();
    await sink.flush();
    warn.mockRestore();
  });
});

/**
 * The op budget must CANCEL, not merely stop waiting.
 *
 * Measured against the live bucket (2026-09-10, WSL → Hetzner hel1): the store is
 * request-rate limited, not bandwidth limited — a 40 KB PUT and a 3 MB PUT cost the
 * same seconds, and per-op latency grows with how many ops are in flight while
 * throughput stays flat. Under that regime an abandoned-but-still-running request is
 * not free: it keeps its socket and keeps consuming the store's scarce request rate
 * while the freed worker starts ANOTHER op beside it. The concurrency bound then
 * bounds only what the sink is WATCHING, in-flight requests climb above it, latency
 * climbs with them, and more ops blow the budget — the timeout feeds itself.
 */
describe('the op budget CANCELS the request instead of abandoning it', () => {
  class SignalStore implements ObjectStore {
    existsSignal: AbortSignal | undefined;
    putSignal: AbortSignal | undefined;
    hangPut = false;
    hangExists = false;

    async exists(key: string, signal?: AbortSignal): Promise<boolean> {
      this.existsSignal = signal;
      if (this.hangExists) return new Promise<boolean>(() => {});
      return false;
    }

    async put(key: string, body: Buffer, opts: PutOptions, signal?: AbortSignal): Promise<void> {
      this.putSignal = signal;
      if (this.hangPut) return new Promise<void>(() => {});
    }
  }

  it('hands put() a signal and ABORTS it when the budget expires', async () => {
    const store = new SignalStore();
    store.hangPut = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 20 });
    await send(sink, cap());
    expect(store.putSignal).toBeDefined();
    expect(store.putSignal!.aborted).toBe(true);
  });

  it('hands exists() a signal and ABORTS it when the budget expires', async () => {
    const store = new SignalStore();
    store.hangExists = true;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 20 });
    await send(sink, cap());
    expect(store.existsSignal).toBeDefined();
    expect(store.existsSignal!.aborted).toBe(true);
  });

  it('leaves the signal UNaborted when the op finishes inside its budget', async () => {
    const store = new SignalStore();
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000 });
    await send(sink, cap());
    expect(store.putSignal!.aborted).toBe(false);
    expect(store.existsSignal!.aborted).toBe(false);
  });

  it('counts a timed-out op apart from a store that answered with an error', async () => {
    const hung = new SignalStore();
    hung.hangPut = true;
    const timing = new ObjectStoreCaptureSink(hung, { ...CONFIG, putTimeoutMs: 20 });
    await send(timing, cap());
    expect(timing.stats()).toMatchObject({ failed: 1, timedOut: 1 });

    // A store that FAILS fast is a different fault with a different remedy: it is not
    // the budget that ended the op, so it must not read as one on the health page.
    const erroring = new FakeObjectStore();
    erroring.failPut = true;
    const failing = new ObjectStoreCaptureSink(erroring, { ...CONFIG, putTimeoutMs: 5_000 });
    await send(failing, cap());
    expect(failing.stats()).toMatchObject({ failed: 1, timedOut: 0 });
  });

  it('times the asset lane out on ITS budget and aborts that op too', async () => {
    const store = new SignalStore();
    store.hangPut = true;
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG,
      assetsEnabled: true,
      putTimeoutMs: 5_000,
      imagePutTimeoutMs: 20,
    });
    await send(sink, cap({ lane: 'asset', bytes: PNG, contentType: 'image/png' }));
    expect(store.putSignal!.aborted).toBe(true);
    expect(sink.stats()).toMatchObject({ assetFailed: 1, timedOut: 1 });
  });
});

/**
 * Every latency this sink reports is wall clock read inside this process, so a pod
 * that is not being SCHEDULED reports a slow bucket. That is the reading prod was
 * missing: putP95 16–29 s against a bucket a curl in the same pod answered in 0.6 s
 * is either a slow store or a starved process, and the counters could not tell them
 * apart. Measured 2026-09-10 from WSL, an idle process shows lag p50/p95 of 0–1 ms
 * while the very same PUTs take seconds — so a fat lag beside a fat putP95 points at
 * the process, and a flat one points at the store.
 */
describe('the sink reports its own scheduling delay beside the store latencies', () => {
  it('reads ~zero lag when nothing is holding the event loop', async () => {
    const store = new FakeObjectStore();
    store.putDelayMs = 320; // an await, not a block: the loop stays free
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 5_000 });
    await send(sink, cap());
    expect(sink.stats().eventLoopLagP95).toBeLessThan(100);
  });

  it('reports the delay when something BLOCKS the loop through the op', async () => {
    class BlockingStore extends FakeObjectStore {
      override async put(key: string, body: Buffer, opts: PutOptions): Promise<void> {
        const until = Date.now() + 600;
        while (Date.now() < until) {
          /* hold the loop, exactly as a long synchronous parse would */
        }
        await super.put(key, body, opts);
      }
    }
    const sink = new ObjectStoreCaptureSink(new BlockingStore(), { ...CONFIG, putTimeoutMs: 5_000 });
    await send(sink, cap());
    expect(sink.stats().eventLoopLagP95).toBeGreaterThan(100);
  });

  it('holds no sampling timer once the queue has drained', async () => {
    const sink = new ObjectStoreCaptureSink(new FakeObjectStore(), CONFIG);
    await send(sink, cap());
    expect((sink as unknown as { lagTimer?: unknown }).lagTimer).toBeUndefined();
  });
});

/**
 * The default budget has to sit ABOVE what the store actually costs, because the budget
 * now DESTROYS the body rather than merely mis-counting a PUT that still landed.
 *
 * At 5 s it sat below the measured PUT p50 (3.5–5.7 s on the slow path measured
 * 2026-09-10), so a deployment that forgot RAW_STORE_PUT_TIMEOUT_MS would abort roughly
 * half its uploads and lose those bodies — page bodies being the ones nothing re-fetches.
 * The default now matches the deployed value instead of being one missing manifest key
 * away from an outage.
 */
describe('the default store-op budget', () => {
  it('is 30 s — above the measured cost of a PUT, not below it', () => {
    expect(DEFAULT_PUT_TIMEOUT_MS).toBe(30_000);
  });

  it('lets an op that outlasts the OLD 5 s default finish and be stored', async () => {
    jest.useFakeTimers();
    try {
      const store = new FakeObjectStore();
      store.putDelayMs = 8_000; // over the old default, under the new one
      const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: undefined });
      const done = send(sink, cap());
      await jest.advanceTimersByTimeAsync(20_000);
      await done;
      expect(sink.stats()).toMatchObject({ stored: 1, failed: 0, timedOut: 0 });
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * ONE budget for the whole op, not one per store call.
 *
 * `RAW_STORE_PUT_TIMEOUT_MS=30000` told an operator that a capture may spend 30 s on the
 * store. It actually bought a 60 s worst case, because the HEAD and the PUT each got the
 * full budget — and the asset lane's 60 s was really 120 s. That gap mattered little
 * while a timeout only mis-counted; now that it destroys the body, the number an
 * operator sets has to be the number the op can spend.
 */
describe('the budget bounds the whole op, HEAD and PUT together', () => {
  it('ends the op when the HEAD and the PUT TOGETHER outlast the budget', async () => {
    const store = new FakeObjectStore();
    store.existsDelayMs = 80; // each half fits the budget on its own …
    store.putDelayMs = 80; // … and together they cannot
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 120 });
    await send(sink, cap());
    expect(sink.stats()).toMatchObject({ stored: 0, failed: 1, timedOut: 1 });
    expect(store.puts).toHaveLength(0); // and the PUT the budget cannot afford is never sent
  });

  it('still stores when the two together fit inside the budget', async () => {
    const store = new FakeObjectStore();
    store.existsDelayMs = 20;
    store.putDelayMs = 20;
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 400 });
    await send(sink, cap());
    expect(sink.stats()).toMatchObject({ stored: 1, failed: 0, timedOut: 0 });
  });

  it('spends the ASSET budget the same way, across that lane’s HEAD and PUT', async () => {
    const store = new FakeObjectStore();
    store.existsDelayMs = 80;
    store.putDelayMs = 80;
    const sink = new ObjectStoreCaptureSink(store, {
      ...CONFIG,
      assetsEnabled: true,
      putTimeoutMs: 5_000,
      imagePutTimeoutMs: 120,
    });
    await send(sink, cap({ lane: 'asset', bytes: PNG, contentType: 'image/png' }));
    expect(sink.stats()).toMatchObject({ assetStored: 0, assetFailed: 1, timedOut: 1 });
  });

  it('a dedup hit costs only its HEAD and is never charged a PUT', async () => {
    const store = new FakeObjectStore();
    store.existsDelayMs = 80;
    store.putDelayMs = 10_000; // would blow any budget if it were ever reached
    const c = cap();
    store.existing.add(`raw-html/sha256/${c.sha256.slice(0, 2)}/${c.sha256}.html.gz`);
    const sink = new ObjectStoreCaptureSink(store, { ...CONFIG, putTimeoutMs: 400 });
    await send(sink, c);
    expect(sink.stats()).toMatchObject({ deduped: 1, stored: 0, failed: 0, timedOut: 0 });
  });
});

/**
 * A percentile cannot see a single long stall, and a single long stall is the question.
 *
 * The sampler resets its due time after each reading, so a block of duration D yields
 * exactly ONE sample of ~D rather than D/250 of them. In a full 512-sample window that
 * lone outlier sits below p95 — so a 3 s stall reports `eventLoopLagP95: 0`. The number
 * that answers "was this pod stalled while that 29 s PUT was outstanding?" therefore has
 * to be a high-water mark, and one that does not fall out of a window.
 */
describe('the worst event-loop stall stays visible', () => {
  class BlocksOnceStore extends FakeObjectStore {
    private blocked = false;
    override async put(key: string, body: Buffer, opts: PutOptions): Promise<void> {
      if (!this.blocked) {
        this.blocked = true;
        const until = Date.now() + 600;
        while (Date.now() < until) {
          /* hold the loop, exactly as a long synchronous parse would */
        }
      }
      await super.put(key, body, opts);
    }
  }

  it('records the stall as a high-water mark, not only in the percentiles', async () => {
    const sink = new ObjectStoreCaptureSink(new BlocksOnceStore(), { ...CONFIG, putTimeoutMs: 5_000 });
    await send(sink, cap({ bytes: Buffer.from('first') }));
    expect(sink.stats().eventLoopLagMax).toBeGreaterThan(100);
  });

  it('keeps it after the quiet captures that follow, where a window would drop it', async () => {
    const sink = new ObjectStoreCaptureSink(new BlocksOnceStore(), { ...CONFIG, putTimeoutMs: 5_000 });
    await send(sink, cap({ bytes: Buffer.from('first') }));
    const worst = sink.stats().eventLoopLagMax;
    expect(worst).toBeGreaterThan(100);
    for (let i = 0; i < 6; i++) await send(sink, cap({ bytes: Buffer.from(`quiet-${i}`) }));
    expect(sink.stats().eventLoopLagMax).toBe(worst);
  });

  it('reads zero on a sink that has never been held up', async () => {
    const sink = new ObjectStoreCaptureSink(new FakeObjectStore(), CONFIG);
    await send(sink, cap());
    expect(sink.stats().eventLoopLagMax).toBeLessThan(100);
  });
});
