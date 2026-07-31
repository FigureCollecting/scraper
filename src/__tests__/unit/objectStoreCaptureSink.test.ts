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
