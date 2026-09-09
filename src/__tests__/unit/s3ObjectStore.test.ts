import { jest } from '@jest/globals';
import { NoopCaptureSink, buildRawCapture } from '../../services/captureSink';
import { ObjectStoreCaptureSink, type ObjectStore } from '../../services/objectStoreCaptureSink';
import {
  MAX_CONFIGURABLE_IMAGE_BYTES,
  rawStoreView,
  loadRawStoreConfigFromEnv,
  createRawCaptureSink,
  isImagePersistenceEnabled,
  toS3MetaData,
  flushRawCaptureSink,
  DEFAULT_RAW_STORE_SHUTDOWN_FLUSH_MS,
} from '../../services/s3ObjectStore';

// Mirrors the ratified "1.B scraper Deployment wiring" fragment: PERSIST_RAW_HTML
// gate + prefixed credential env-var names (the process sees RAW_STORE_S3_ACCESS_KEY_ID,
// not the Secret's internal key ACCESS_KEY_ID).
const FULL_ENV = {
  PERSIST_RAW_HTML: 'true',
  RAW_STORE_S3_ENDPOINT: 'https://hel1.your-objectstorage.com',
  RAW_STORE_S3_REGION: 'hel1',
  RAW_STORE_S3_BUCKET: 'mindsignals-raw',
  RAW_STORE_S3_PREFIX: 'raw-html/',
  RAW_STORE_KEY_SCHEME: 'sha256-v1',
  RAW_STORE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  RAW_STORE_S3_SECRET_ACCESS_KEY: 'secret-example',
} as unknown as NodeJS.ProcessEnv;

describe('loadRawStoreConfigFromEnv', () => {
  it('parses the full contract + credential from the prefixed env names', () => {
    const loaded = loadRawStoreConfigFromEnv(FULL_ENV);
    expect(loaded).not.toBeNull();
    expect(loaded!.config).toMatchObject({
      endpoint: 'https://hel1.your-objectstorage.com',
      region: 'hel1',
      bucket: 'mindsignals-raw',
      prefix: 'raw-html/',
      keyScheme: 'sha256-v1',
    });
    expect(loaded!.creds).toEqual({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' });
  });

  it('is gated by PERSIST_RAW_HTML: fully configured but flag off → null (feature off, silent)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...FULL_ENV } as Record<string, unknown>;
    delete env.PERSIST_RAW_HTML;
    expect(loadRawStoreConfigFromEnv(env as NodeJS.ProcessEnv)).toBeNull();
    expect(warn).not.toHaveBeenCalled(); // off-by-design is not a warning
    warn.mockRestore();
  });

  it('enabled-but-incomplete → null AND a loud WARN (never a silent Noop)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...FULL_ENV } as Record<string, unknown>;
    delete env.RAW_STORE_S3_ACCESS_KEY_ID; // the exact mismatch the review caught
    expect(loadRawStoreConfigFromEnv(env as NodeJS.ProcessEnv)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String((warn.mock.calls[0] ?? [])[0])).toMatch(/RAW_STORE_S3_ACCESS_KEY_ID/);
    warn.mockRestore();
  });

  it('defaults prefix/jsonPrefix/keyScheme when omitted', () => {
    const env = { ...FULL_ENV } as Record<string, unknown>;
    delete env.RAW_STORE_S3_PREFIX;
    delete env.RAW_STORE_KEY_SCHEME;
    const loaded = loadRawStoreConfigFromEnv(env as NodeJS.ProcessEnv)!;
    expect(loaded.config.prefix).toBe('raw-html/');
    expect(loaded.config.jsonPrefix).toBe('raw-json/');
    expect(loaded.config.keyScheme).toBe('sha256-v1');
  });

  it('drops an invalid putTimeoutMs so the sink falls back to its default', () => {
    const loaded = loadRawStoreConfigFromEnv({ ...FULL_ENV, RAW_STORE_PUT_TIMEOUT_MS: 'nope' } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.putTimeoutMs).toBeUndefined();
  });

  it('reads the sink admission bounds RAW_STORE_CONCURRENCY / RAW_STORE_QUEUE_MAX', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_CONCURRENCY: '8',
      RAW_STORE_QUEUE_MAX: '1200',
      RAW_STORE_QUEUE_MAX_BYTES: '67108864',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.concurrency).toBe(8);
    expect(loaded.config.queueMax).toBe(1200);
    expect(loaded.config.queueMaxBytes).toBe(67108864);
  });

  it('drops nonsense admission bounds so the sink falls back to 4 / 500', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_CONCURRENCY: 'lots',
      RAW_STORE_QUEUE_MAX: '-1',
      RAW_STORE_QUEUE_MAX_BYTES: 'huge',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.concurrency).toBeUndefined();
    expect(loaded.config.queueMax).toBeUndefined();
    expect(loaded.config.queueMaxBytes).toBeUndefined();
  });

  it('reads RAW_STORE_ASSET_QUEUE_SHARE — the slice of the queue assets may occupy', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_ASSET_QUEUE_SHARE: '0.5',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.assetQueueShare).toBe(0.5);
  });

  it('clamps the asset share at 1 and drops a nonsense one, so the sink keeps its 0.75', () => {
    const over = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_ASSET_QUEUE_SHARE: '4',
    } as unknown as NodeJS.ProcessEnv)!;
    // A share above the whole queue is not a bigger reservation, it is none at all.
    expect(over.config.assetQueueShare).toBe(1);

    for (const raw of ['most', '0', '-0.5']) {
      const bad = loadRawStoreConfigFromEnv({
        ...FULL_ENV,
        RAW_STORE_ASSET_QUEUE_SHARE: raw,
      } as unknown as NodeJS.ProcessEnv)!;
      expect(bad.config.assetQueueShare).toBeUndefined();
    }
  });

  it('defaults the asset lane: imagePrefix raw-img/ and no explicit byte ceiling', () => {
    const loaded = loadRawStoreConfigFromEnv(FULL_ENV)!;
    expect(loaded.config.imagePrefix).toBe('raw-img/');
    expect(loaded.config.maxImageBytes).toBeUndefined();
  });

  it('reads RAW_STORE_S3_IMAGE_PREFIX and RAW_STORE_IMAGE_MAX_BYTES', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_S3_IMAGE_PREFIX: 'img/',
      RAW_STORE_IMAGE_MAX_BYTES: '2048',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.imagePrefix).toBe('img/');
    expect(loaded.config.maxImageBytes).toBe(2048);
  });

  it('drops an invalid RAW_STORE_IMAGE_MAX_BYTES so the sink keeps its 10 MiB default', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_IMAGE_MAX_BYTES: '-1',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.maxImageBytes).toBeUndefined();
  });
});

describe('isImagePersistenceEnabled — the asset lane kill switch', () => {
  it('is OFF by default, even with page capture fully enabled', () => {
    expect(isImagePersistenceEnabled(FULL_ENV)).toBe(false);
    expect(isImagePersistenceEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('requires the exact string "true" — no truthy near-misses', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', '']) {
      expect(isImagePersistenceEnabled({ PERSIST_RAW_IMAGES: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(isImagePersistenceEnabled({ PERSIST_RAW_IMAGES: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is INDEPENDENT of PERSIST_RAW_HTML in both directions', () => {
    expect(isImagePersistenceEnabled({ PERSIST_RAW_IMAGES: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isImagePersistenceEnabled({ PERSIST_RAW_HTML: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('createRawCaptureSink', () => {
  it('returns a NoopCaptureSink when capture is not configured', () => {
    expect(createRawCaptureSink({} as NodeJS.ProcessEnv)).toBeInstanceOf(NoopCaptureSink);
  });

  it('returns a real ObjectStoreCaptureSink when configured + enabled', () => {
    expect(createRawCaptureSink(FULL_ENV)).toBeInstanceOf(ObjectStoreCaptureSink);
  });

  it('fails fast on an unknown key scheme rather than silently dropping captures', () => {
    const env = { ...FULL_ENV, RAW_STORE_KEY_SCHEME: 'sha256-v2' } as unknown as NodeJS.ProcessEnv;
    expect(() => createRawCaptureSink(env)).toThrow(/sha256-v1/);
  });
});

describe('toS3MetaData — the real S3 header boundary', () => {
  it('emits Content-Type + x-amz-meta-* and NEVER Content-Encoding', () => {
    const md = toS3MetaData({
      contentType: 'application/gzip',
      metadata: { url: 'https://x.test/1', 'fetched-at': '2026-07-31T00:00:00.000Z', site: 'x.test' },
    });
    expect(md['Content-Type']).toBe('application/gzip');
    expect(md['x-amz-meta-url']).toBe('https://x.test/1');
    expect(md['x-amz-meta-fetched-at']).toBe('2026-07-31T00:00:00.000Z');
    expect(md['x-amz-meta-site']).toBe('x.test');
    expect(md['Content-Encoding']).toBeUndefined();
    expect(md['content-encoding']).toBeUndefined();
  });

  it('handles absent metadata (only Content-Type)', () => {
    expect(toS3MetaData({ contentType: 'application/gzip' })).toEqual({ 'Content-Type': 'application/gzip' });
  });
});

// The docs sell an images-only wiring (a different corpus, different rights). The
// composition root has to actually build a sink for it, and the sink it builds has
// to refuse the lane whose switch is off.
describe('the two switches gate the composition root independently', () => {
  const IMAGES_ONLY = (() => {
    const env = { ...FULL_ENV, PERSIST_RAW_IMAGES: 'true' } as Record<string, unknown>;
    delete env.PERSIST_RAW_HTML;
    return env as unknown as NodeJS.ProcessEnv;
  })();

  it('builds a REAL sink for an images-only env (never a silent Noop)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createRawCaptureSink(IMAGES_ONLY)).toBeInstanceOf(ObjectStoreCaptureSink);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns loudly when an images-only env is incompletely configured', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...IMAGES_ONLY } as Record<string, unknown>;
    delete env.RAW_STORE_S3_BUCKET;
    expect(loadRawStoreConfigFromEnv(env as NodeJS.ProcessEnv)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String((warn.mock.calls[0] ?? [])[0])).toMatch(/RAW_STORE_S3_BUCKET/);
    warn.mockRestore();
  });

  it('carries each switch into the config as a per-lane enable flag', () => {
    expect(loadRawStoreConfigFromEnv(IMAGES_ONLY)!.config).toMatchObject({
      pagesEnabled: false,
      assetsEnabled: true,
    });
    expect(loadRawStoreConfigFromEnv(FULL_ENV)!.config).toMatchObject({
      pagesEnabled: true,
      assetsEnabled: false,
    });
    expect(
      loadRawStoreConfigFromEnv({ ...FULL_ENV, PERSIST_RAW_IMAGES: 'true' } as unknown as NodeJS.ProcessEnv)!.config,
    ).toMatchObject({ pagesEnabled: true, assetsEnabled: true });
  });

  it('stays null and silent when BOTH switches are off', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...FULL_ENV } as Record<string, unknown>;
    delete env.PERSIST_RAW_HTML;
    expect(loadRawStoreConfigFromEnv(env as NodeJS.ProcessEnv)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('RAW_STORE_IMAGE_PUT_TIMEOUT_MS', () => {
  it('is read into the config so the asset lane can outlast the page budget', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_IMAGE_PUT_TIMEOUT_MS: '45000',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.imagePutTimeoutMs).toBe(45000);
  });

  it('drops an invalid value so the sink keeps its default', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_IMAGE_PUT_TIMEOUT_MS: '0',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.imagePutTimeoutMs).toBeUndefined();
  });
});

describe('rawStoreView — the ops-readable view of whichever sink was built', () => {
  it('reports configured:false for a Noop sink (no counters to read)', () => {
    expect(rawStoreView(new NoopCaptureSink())).toEqual({ configured: false });
  });

  it('reports the live counters for a real sink', () => {
    const view = rawStoreView(createRawCaptureSink(FULL_ENV));
    expect(view.configured).toBe(true);
    expect(view.stats).toMatchObject({ stored: 0, assetStored: 0, assetSkipped: { notImage: 0 } });
  });

  it('never throws when stats() does — health must not 500 on a counter read', () => {
    const hostile = { capture: async () => {}, stats: () => { throw new Error('boom'); } };
    expect(rawStoreView(hostile as never)).toEqual({ configured: false });
  });
});

describe('RAW_STORE_IMAGE_MAX_BYTES is bounded from above too', () => {
  it('clamps an absurd ceiling instead of removing the ceiling', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_IMAGE_MAX_BYTES: '1e30',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.maxImageBytes).toBe(MAX_CONFIGURABLE_IMAGE_BYTES);
  });

  it('leaves a sane ceiling exactly as configured', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_IMAGE_MAX_BYTES: '2048',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.maxImageBytes).toBe(2048);
  });
});


// ---------------------------------------------------------------------------
// Shutdown flush: SIGTERM arrives with a queue that has not been written yet, and
// those bytes are write-once with no retry anywhere. Draining is bounded, because a
// pod that will not exit is a worse outcome than a handful of lost captures.
// ---------------------------------------------------------------------------
describe('flushRawCaptureSink', () => {
  const stats = (queued: number, inFlight: number) => ({
    stored: 0, deduped: 0, failed: 0, skippedDisabled: 0,
    assetStored: 0, assetDeduped: 0, assetFailed: 0,
    assetSkipped: { notImage: 0, tooLarge: 0, empty: 0, disabled: 0 },
    queued, inFlight, dropped: 0, droppedBytes: 0, queuedBytes: 0,
    queueWaitP50: 0, queueWaitP95: 0, putP50: 0, putP95: 0, headP50: 0, headP95: 0,
  });

  it('drains the queue and reports nothing abandoned', async () => {
    const sink = {
      capture: async () => undefined,
      flush: jest.fn(async () => undefined),
      stats: () => stats(0, 0),
    };
    await expect(flushRawCaptureSink({ sink, timeoutMs: 1_000 })).resolves.toEqual({
      drained: true, abandoned: 0,
    });
    expect(sink.flush).toHaveBeenCalledTimes(1);
  });

  it('gives up at the budget and NAMES how many captures it abandoned', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = {
      capture: async () => undefined,
      flush: () => new Promise<void>(() => {}), // a store that will not answer
      stats: () => stats(7, 2),
    };
    const outcome = await flushRawCaptureSink({ sink, timeoutMs: 20 });

    // Bounded: a pod that refuses to exit is worse than the captures it is holding.
    expect(outcome).toEqual({ drained: false, abandoned: 9 });
    expect(warn.mock.calls.some(a => String(a[0]).includes('9'))).toBe(true);
    warn.mockRestore();
  });

  it('is a no-op for a sink that has no flush at all (the Noop sink)', async () => {
    await expect(flushRawCaptureSink({ sink: new NoopCaptureSink(), timeoutMs: 10 })).resolves.toEqual({
      drained: true, abandoned: 0,
    });
  });

  it('never throws when the flush itself fails — shutdown continues', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = {
      capture: async () => undefined,
      flush: async () => { throw new Error('store exploded'); },
    };
    await expect(flushRawCaptureSink({ sink, timeoutMs: 100 })).resolves.toEqual({
      drained: false, abandoned: 0,
    });
    warn.mockRestore();
  });

  it('reads the budget from RAW_STORE_SHUTDOWN_FLUSH_MS, defaulting to 8s', async () => {
    const seen: number[] = [];
    const sink = {
      capture: async () => undefined,
      flush: async () => { seen.push(Date.now()); },
    };
    await flushRawCaptureSink({ sink, env: { RAW_STORE_SHUTDOWN_FLUSH_MS: 'nope' } as NodeJS.ProcessEnv });
    expect(DEFAULT_RAW_STORE_SHUTDOWN_FLUSH_MS).toBe(8_000);
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The shutdown drain, end to end through a real sink: the budget is spent on PAGES
// first. Drained first-come-first-served, the flush spent its eight seconds on
// re-fetchable images and abandoned the one capture nothing would ever fetch again.
// ---------------------------------------------------------------------------
describe('flushRawCaptureSink — pages first inside the budget', () => {
  /** PUTs park until released, so the test decides exactly how far the drain gets. */
  class ParkingStore implements ObjectStore {
    readonly keys: string[] = [];
    readonly parked: Array<() => void> = [];
    async exists(): Promise<boolean> { return false; }
    async put(key: string): Promise<void> {
      this.keys.push(key);
      await new Promise<void>(resolve => { this.parked.push(resolve); });
    }
    release(): void { this.parked.splice(0).forEach(r => r()); }
  }
  const tick = () => new Promise(r => setImmediate(r));
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 20_000 && !cond(); i += 1) await tick();
  };
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR')]);
  const image = (i: number) => buildRawCapture({
    url: `https://cdn.test/${i}.png`, lane: 'asset', bytes: Buffer.concat([PNG, Buffer.alloc(4, i)]),
  });

  it('spends the budget on the PAGE first — what it abandons is the re-fetchable assets', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ParkingStore();
    const sink = new ObjectStoreCaptureSink(store, {
      endpoint: 'https://hel1.your-objectstorage.com', region: 'hel1', bucket: 'mindsignals-raw',
      prefix: 'raw-html/', imagePrefix: 'raw-img/', keyScheme: 'sha256-v1',
      concurrency: 1, putTimeoutMs: 60_000, imagePutTimeoutMs: 60_000,
    });
    // SIGTERM arrives with one image uploading, three more waiting, and behind all of
    // them the one capture nothing will ever fetch again.
    for (let i = 1; i <= 4; i += 1) await expect(sink.capture(image(i))).resolves.toEqual({ admitted: true });
    await until(() => store.parked.length === 1);
    const page = buildRawCapture({ url: 'https://store.test/item/1', lane: 'wire', bytes: Buffer.from('<html>item 1</html>') });
    await expect(sink.capture(page)).resolves.toEqual({ admitted: true });
    expect(sink.stats()).toMatchObject({ queued: 4, inFlight: 1 });

    const flushing = flushRawCaptureSink({ sink, timeoutMs: 1_000 });
    store.release(); // the running upload finishes; from here the budget decides what lands
    await until(() => store.keys.length === 2);
    // The worker took the page — not image 2, which had been waiting far longer.
    expect(store.keys[1]).toBe(`raw-html/sha256/${page.sha256.slice(0, 2)}/${page.sha256}.html.gz`);
    store.release(); // the page lands; the worker moves on to image 2 and parks there until the budget runs out

    await expect(flushing).resolves.toEqual({ drained: false, abandoned: 3 });
    // Everything abandoned is an image the next pass re-fetches; the page is in the bucket.
    expect(store.keys.filter(k => k.endsWith('.html.gz'))).toHaveLength(1);
    expect(store.keys).toHaveLength(3);

    const done = sink.flush();
    for (let i = 0; i < 100 && sink.stats().queued + sink.stats().inFlight > 0; i += 1) { store.release(); await tick(); }
    await done;
    warn.mockRestore();
  });
});
