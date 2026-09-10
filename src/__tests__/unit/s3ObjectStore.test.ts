import { jest } from '@jest/globals';
import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:https';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoopCaptureSink, buildRawCapture } from '../../services/captureSink';
import {
  ObjectStoreCaptureSink,
  MIN_RAW_STORE_ASSET_MAX_WAIT_MS,
  DEFAULT_IMAGE_PUT_TIMEOUT_MS,
  resolveRawStoreConcurrency,
  type ObjectStore,
  type RawStoreConfig,
} from '../../services/objectStoreCaptureSink';
import {
  MAX_CONFIGURABLE_IMAGE_BYTES,
  rawStoreView,
  loadRawStoreConfigFromEnv,
  createRawCaptureSink,
  isImagePersistenceEnabled,
  toS3MetaData,
  S3ObjectStore,
  getRawCaptureSink,
  socketBackstopMs,
  MINIO_RETRYABLE_STATUSES,
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

  it('reads RAW_STORE_ASSET_MAX_WAIT_MS — how long the asset lane may wait behind pages before it goes next', () => {
    const loaded = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_ASSET_MAX_WAIT_MS: '45000',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(loaded.config.assetMaxWaitMs).toBe(45_000);
  });

  it('clamps RAW_STORE_ASSET_MAX_WAIT_MS at 1 s from below and drops a nonsense one, so the sink keeps its 30 s', () => {
    const low = loadRawStoreConfigFromEnv({
      ...FULL_ENV,
      RAW_STORE_ASSET_MAX_WAIT_MS: '250',
    } as unknown as NodeJS.ProcessEnv)!;
    // A window under a second is round-robin wearing a number: the page reservation's turn
    // handed straight back to the images it was taken from.
    expect(low.config.assetMaxWaitMs).toBe(MIN_RAW_STORE_ASSET_MAX_WAIT_MS);

    for (const raw of ['soon', '0', '-5']) {
      const bad = loadRawStoreConfigFromEnv({
        ...FULL_ENV,
        RAW_STORE_ASSET_MAX_WAIT_MS: raw,
      } as unknown as NodeJS.ProcessEnv)!;
      expect(bad.config.assetMaxWaitMs).toBeUndefined();
    }
    expect(loadRawStoreConfigFromEnv(FULL_ENV)!.config.assetMaxWaitMs).toBeUndefined();
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

/**
 * The adapter's half of the cancellation contract, proven on a REAL socket.
 *
 * The sink can only bound an op if the bound reaches the connection: minio takes no
 * AbortSignal, so a budget that merely stops waiting leaves the request running,
 * holding a socket and consuming the store's request rate long after the sink has
 * written the op off. These tests drive the actual minio client against a local
 * server that accepts and never answers — the exact shape of the prod tail.
 */
describe('S3ObjectStore — an aborted op is torn down at the socket', () => {
  const servers: http.Server[] = [];

  const silentServer = async (): Promise<{ port: number; closedSockets: () => number; seen: () => number }> => {
    let closed = 0;
    let seen = 0;
    const server = http.createServer(() => {
      seen += 1; // accept the request and never answer it
    });
    server.on('connection', socket => {
      socket.once('close', () => {
        closed += 1;
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, closedSockets: () => closed, seen: () => seen };
  };

  const storeAt = (port: number): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        pathStyle: true,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  const settle = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 50));
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  });

  it('destroys the in-flight PUT when the signal aborts, and rejects', async () => {
    const { port, closedSockets, seen } = await silentServer();
    const controller = new AbortController();
    const put = storeAt(port).put('raw-html/x', Buffer.from('body'), { contentType: 'application/gzip' }, controller.signal);
    const settled = put.then(
      () => 'resolved',
      () => 'rejected',
    );
    await settle();
    expect(seen()).toBe(1); // the request really is on the wire and unanswered
    controller.abort();
    await expect(settled).resolves.toBe('rejected');
    await settle();
    expect(closedSockets()).toBe(1); // the socket is GONE, not parked in the agent
  });

  it('destroys the in-flight HEAD when the signal aborts, and rejects', async () => {
    const { port, closedSockets } = await silentServer();
    const controller = new AbortController();
    const exists = storeAt(port).exists('raw-html/x', controller.signal);
    const settled = exists.then(
      () => 'resolved',
      () => 'rejected',
    );
    await settle();
    controller.abort();
    await expect(settled).resolves.toBe('rejected');
    await settle();
    expect(closedSockets()).toBe(1);
  });

  it('rejects immediately when handed a signal that is already aborted', async () => {
    const { port, seen } = await silentServer();
    await expect(
      storeAt(port).put('raw-html/x', Buffer.from('body'), { contentType: 'application/gzip' }, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(seen()).toBe(0); // never dialled at all
  });
});

/**
 * The raw-store client gets its OWN connection pool.
 *
 * minio defaults to `https.globalAgent`, which the whole process shares and which
 * Node ships with maxSockets Infinity: uploads compete with every other https call
 * the scraper makes, and nothing at the transport caps connections at the sink's
 * concurrency — so an op the sink has written off can still hold a socket beside the
 * replacement op the freed worker started.
 */
describe('S3ObjectStore — a dedicated, bounded keep-alive pool', () => {
  const agentOf = (store: S3ObjectStore): Agent =>
    (store as unknown as { client: { transportAgent: Agent } }).client.transportAgent;

  const build = (over: Partial<RawStoreConfig> = {}): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: 'https://hel1.your-objectstorage.com',
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        ...over,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  it('never uses the process-wide global agent', () => {
    expect(agentOf(build())).not.toBe(https.globalAgent);
  });

  it('keeps connections alive so a burst does not re-handshake per object', () => {
    expect(agentOf(build()).options.keepAlive).toBe(true);
  });

  it('caps sockets at the sink concurrency the same config asks for', () => {
    expect(agentOf(build({ concurrency: 12 })).options.maxSockets).toBe(12);
    expect(agentOf(build({ concurrency: 24 })).options.maxSockets).toBe(24);
  });

  it('falls back to the sink default concurrency when the config names none', () => {
    expect(agentOf(build()).options.maxSockets).toBe(resolveRawStoreConcurrency(undefined));
  });
});

/**
 * The abort must also reap a request that starts AFTER it fired.
 *
 * minio retries a retryable status (408/429/499/500/502/503/504/520) ONCE, after a
 * 200–400 ms backoff sleep. So the store answers 503, minio sleeps, the budget expires
 * during that sleep — and the retry is dialled into an op whose abort has already been
 * consumed. Left untracked it is worse than the bug this all fixes: on the capped pool
 * it holds one of RAW_STORE_CONCURRENCY's sockets for as long as the store takes to
 * answer, and the REPLACEMENT capture the freed worker started burns its whole budget
 * waiting for a socket rather than for the store — the same invisible wait, moved one
 * layer down. Before the pool was capped that orphan merely wasted a request.
 */
describe('S3ObjectStore — an abort reaps the retry minio starts during its backoff', () => {
  const servers: http.Server[] = [];

  /**
   * `doomed` keys get one 503 (which minio will retry) and then silence; `replacement`
   * keys are answered at once. Keyed on the PATH, not on a call counter, so the
   * assertions do not depend on whether the doomed retry ever reaches the wire.
   */
  const retryThenHangServer = async (): Promise<{
    port: number;
    doomedHits: () => number;
    openSockets: () => number;
    connectionsOpened: () => number;
  }> => {
    let doomedHits = 0;
    let open = 0;
    let opened = 0;
    const server = http.createServer((req, res) => {
      if ((req.url ?? '').includes('doomed')) {
        doomedHits += 1;
        req.resume();
        if (doomedHits === 1) {
          res.writeHead(503);
          res.end();
        }
        return; // every later attempt: accepted and never answered
      }
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { ETag: '"x"' });
        res.end();
      });
    });
    server.on('connection', socket => {
      open += 1;
      opened += 1;
      socket.once('close', () => {
        open -= 1;
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      doomedHits: () => doomedHits,
      openSockets: () => open,
      connectionsOpened: () => opened,
    };
  };

  const storeAt = (port: number, concurrency?: number): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        pathStyle: true,
        concurrency,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  const poolOf = (store: S3ObjectStore): Agent =>
    (store as unknown as { client: { transportAgent: Agent } }).client.transportAgent;

  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (cond: () => boolean, budgetMs = 3_000): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    while (!cond() && Date.now() < deadline) await wait(10);
  };
  /** Never hang the suite on the very defect under test: an unsettled op is a RESULT. */
  const outcomeOf = (p: Promise<unknown>, budgetMs = 2_500): Promise<string> =>
    Promise.race([
      p.then(() => 'resolved', () => 'rejected'),
      wait(budgetMs).then(() => 'STILL-PENDING'),
    ]);

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(s => {
        s.closeAllConnections?.();
        return new Promise<void>(resolve => s.close(() => resolve()));
      }),
    );
  });

  it('settles the op, and the retry never reaches the store or holds a pool slot', async () => {
    const { port, doomedHits } = await retryThenHangServer();
    const store = storeAt(port);
    const controller = new AbortController();
    const put = store.put('raw-html/doomed', Buffer.from('body'), { contentType: 'application/gzip' }, controller.signal);
    const outcome = outcomeOf(put);
    await until(() => doomedHits() >= 1); // the 503 has landed; minio is now sleeping
    controller.abort(new Error('raw-store op exceeded its budget'));
    // Without the transport's own check this never settles at all: the retry is filed
    // into a context whose abort has already been consumed, and nothing ends it.
    await expect(outcome).resolves.toBe('rejected');

    await wait(900); // long enough for the 200-400 ms backoff to fire the retry
    // The two properties the budget is FOR: the store does no further work for an op
    // that is over, and no slot of the capped pool is held by it.
    expect(doomedHits()).toBe(1);
    expect(Object.values(poolOf(store).sockets).flat()).toHaveLength(0);
  });

  it('leaves the pool a REUSABLE connection, not a strand', async () => {
    const { port, doomedHits, connectionsOpened } = await retryThenHangServer();
    const store = storeAt(port);
    const controller = new AbortController();
    const put = store.put('raw-html/doomed', Buffer.from('body'), { contentType: 'application/gzip' }, controller.signal);
    const outcome = outcomeOf(put);
    await until(() => doomedHits() >= 1);
    controller.abort(new Error('raw-store op exceeded its budget'));
    await expect(outcome).resolves.toBe('rejected');
    await wait(900);

    // A pooled connection left behind is only a fault if it is unusable. The next op
    // must be served BY it — otherwise the abort has quietly cost the pool a socket.
    const before = connectionsOpened();
    await expect(outcomeOf(store.put('raw-html/replacement', Buffer.from('body'), { contentType: 'application/gzip' })))
      .resolves.toBe('resolved');
    expect(connectionsOpened()).toBe(before);
  });

  it('does not starve the replacement op of the one socket a capped pool has', async () => {
    const { port, doomedHits } = await retryThenHangServer();
    const store = storeAt(port, 1); // maxSockets = 1: the escaped retry would own the pool
    const controller = new AbortController();
    const doomed = store.put('raw-html/doomed', Buffer.from('body'), { contentType: 'application/gzip' }, controller.signal);
    const doomedOutcome = outcomeOf(doomed);
    await until(() => doomedHits() >= 1);
    controller.abort(new Error('raw-store op exceeded its budget'));
    await expect(doomedOutcome).resolves.toBe('rejected');

    // The capture the freed worker starts next must wait for the STORE, not for a socket.
    await wait(500); // let the retry fire into the now-aborted op
    const startedAt = Date.now();
    const replacement = store.put('raw-html/replacement', Buffer.from('body'), { contentType: 'application/gzip' });
    await expect(outcomeOf(replacement)).resolves.toBe('resolved');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

/**
 * A request must not outlive its op when the op ends in FAILURE either.
 *
 * The abort path reaps what it tracked; the ordinary failure path did not, and a
 * retryable 5xx takes that path. minio throws such a status after its one retry —
 * typically within a second, far inside a 30 s budget — so the budget never fires, no
 * abort is raised, and the two requests it made are dropped still holding their sockets.
 * minio never drains the error body, so nothing releases them: the agent's keep-alive
 * timeout reaps IDLE pooled sockets, and these are assigned.
 *
 * That was harmless while the adapter used the process-wide agent with maxSockets
 * Infinity — a strand wasted a connection and blocked nobody. Capping the pool at
 * RAW_STORE_CONCURRENCY made it permanent: each 5xx-failing op burns two of the
 * twenty-four slots for good, so a dozen of them across a pod's life stop raw capture
 * outright, and near-silently — timedOut climbs, stored flatlines, and every new
 * diagnostic in this PR reads clean because the wait is for a socket, not for the store.
 */
describe('S3ObjectStore — a failed op leaves nothing holding a pool slot', () => {
  const servers: http.Server[] = [];

  /** Answers every request with `status` and an undrained body, or 200 when null. */
  const statusServer = async (
    status: number | null,
  ): Promise<{ port: number; hits: () => number; connections: () => number }> => {
    let hits = 0;
    let conns = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      req.resume();
      req.once('end', () => {
        if (status === null) {
          res.writeHead(200, { ETag: '"x"' });
          res.end();
          return;
        }
        res.writeHead(status, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>Boom</Code></Error>');
      });
    });
    server.on('connection', () => {
      conns += 1;
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, hits: () => hits, connections: () => conns };
  };

  const storeAt = (port: number, concurrency: number): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        pathStyle: true,
        concurrency,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  const poolOf = (store: S3ObjectStore): Agent =>
    (store as unknown as { client: { transportAgent: Agent } }).client.transportAgent;
  const assigned = (store: S3ObjectStore): number => Object.values(poolOf(store).sockets).flat().length;
  const free = (store: S3ObjectStore): number => Object.values(poolOf(store).freeSockets).flat().length;

  /** One turn for the agent's bookkeeping to catch up with a just-destroyed socket. */
  const settleSockets = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));

  /** Four ops in sequence; a hang is a RESULT here, never a suite that never ends. */
  const runFour = async (store: S3ObjectStore): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      out.push(
        await Promise.race([
          store
            .put(`raw-html/op-${i}`, Buffer.from('body'), { contentType: 'application/gzip' })
            .then(() => 'ok', () => 'rej'),
          new Promise<string>(resolve => setTimeout(() => resolve('HUNG'), 2_500)),
        ]),
      );
    }
    return out;
  };

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(s => {
        s.closeAllConnections?.();
        return new Promise<void>(resolve => s.close(() => resolve()));
      }),
    );
  });

  it('keeps serving after a retryable 5xx, instead of eating the pool two slots at a time', async () => {
    // maxSockets 2 is the whole pool: op0's attempt and its retry take one slot each, so
    // if neither is released op1 waits on a socket that will never come back.
    const { port, hits, connections } = await statusServer(503);
    const store = storeAt(port, 2);
    expect(await runFour(store)).toEqual(['rej', 'rej', 'rej', 'rej']);
    expect(hits()).toBe(8); // four ops, each an attempt plus minio's one retry
    // And the connection is REUSED throughout rather than burned per failure: draining
    // the body minio throws away is what returns the socket, so a 5xx costs a round trip
    // and nothing more.
    expect(connections()).toBe(1);
    await settleSockets();
    expect(assigned(store)).toBe(0);
    expect(free(store)).toBe(1);
  });

  it('does not deadlock an op against its OWN retry at a concurrency of one', async () => {
    // The sharpest case: with a single socket, op0's retry queues behind the socket op0's
    // own first attempt is still holding, and the op can never reach its failure path.
    const { port, connections } = await statusServer(503);
    const store = storeAt(port, 1);
    expect(await runFour(store)).toEqual(['rej', 'rej', 'rej', 'rej']);
    expect(connections()).toBe(1);
    await settleSockets();
    expect(assigned(store)).toBe(0);
  });

  // The controls. A non-retryable status and a success must be untouched by the reap —
  // in particular the success path must still hand its connection back to the pool, or
  // the cure has cost keep-alive.
  it('control: a NON-retryable 4xx reuses its one connection, as it always did', async () => {
    const { port, hits, connections } = await statusServer(403);
    const store = storeAt(port, 2);
    expect(await runFour(store)).toEqual(['rej', 'rej', 'rej', 'rej']);
    expect(hits()).toBe(4); // no retry
    expect(connections()).toBe(1); // one socket, reused throughout
    await settleSockets();
    expect(assigned(store)).toBe(0);
    expect(free(store)).toBe(1);
  });

  it('control: success still leaves its connection WARM in the pool', async () => {
    const { port, hits, connections } = await statusServer(null);
    const store = storeAt(port, 2);
    expect(await runFour(store)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(hits()).toBe(4);
    expect(connections()).toBe(1);
    await settleSockets();
    expect(assigned(store)).toBe(0);
    expect(free(store)).toBe(1);
  });
});

/**
 * `exists` is the HEAD half of every capture, and its catch is an ALLOW LIST: a 404 means
 * "not stored yet", and anything else is a real fault that must reach the sink as one.
 * Swallowing an aborted or failing HEAD as "absent" would turn a broken store into a
 * silent re-upload of everything.
 */
describe('S3ObjectStore — exists, against a real server', () => {
  const servers: http.Server[] = [];

  const headServer = async (present: string): Promise<number> => {
    const server = http.createServer((req, res) => {
      req.resume();
      if ((req.url ?? '').includes(present)) {
        res.writeHead(200, { 'Content-Length': '4', ETag: '"x"', 'Last-Modified': new Date().toUTCString() });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  const storeAt = (port: number): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        pathStyle: true,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(s => {
        s.closeAllConnections?.();
        return new Promise<void>(resolve => s.close(() => resolve()));
      }),
    );
  });

  it('is true for an object the store already holds', async () => {
    await expect(storeAt(await headServer('kept')).exists('raw-html/kept')).resolves.toBe(true);
  });

  it('is false for a 404 — "not stored yet" is not a failure', async () => {
    await expect(storeAt(await headServer('kept')).exists('raw-html/missing')).resolves.toBe(false);
  });

  it('RETHROWS anything that is not a 404, rather than reporting absence', async () => {
    // A 403 read as "absent" would send the sink off to re-upload a corpus it cannot write.
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code></Error>');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await expect(storeAt((server.address() as AddressInfo).port).exists('raw-html/x')).rejects.toThrow();
  });
});

describe('getRawCaptureSink — the process-wide singleton', () => {
  it('builds the sink once and hands the same one to every fetch path', () => {
    // One client and one set of counters for the whole process: a per-caller sink would
    // report a fraction of the traffic on /health/detailed and pool connections apart.
    expect(getRawCaptureSink()).toBe(getRawCaptureSink());
  });
});

/**
 * The pool must recover on its own, not only when a caller happens to carry a budget.
 *
 * `res.resume()` discards the body without buffering, but it never COMPLETES if the body
 * never does — and a socket draining forever is assigned forever. Node emits `'timeout'`
 * on a socket and destroys nothing, minio adds no listener, and the agent's own timeout
 * reaps IDLE pooled sockets, so nothing in the stack ends it. At pool size 1 that is
 * terminal: the op's retry queues behind the socket its first attempt is still draining,
 * so the op never fails and no failure path ever runs.
 *
 * The backstop is deliberately derived from the op budgets and set ABOVE the largest of
 * them. It must never cut a live op short — the asset lane legitimately runs to 60 s on a
 * 10 MiB original — so it is a floor under the pool, not a second budget.
 */
describe('S3ObjectStore — a socket cannot outlive its op', () => {
  const servers: http.Server[] = [];

  /** 503 headers, then a body that is never finished. */
  const neverEndingBodyServer = async (): Promise<{ port: number; connections: () => number }> => {
    let conns = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(503, { 'Content-Type': 'application/xml' });
      res.write('<Error>'); // …and never `end()`
    });
    server.on('connection', () => {
      conns += 1;
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, connections: () => conns };
  };

  const storeAt = (port: number, over: Partial<RawStoreConfig> = {}): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        pathStyle: true,
        concurrency: 1,
        // Tiny budgets so the backstop derived from them is testable in milliseconds.
        putTimeoutMs: 80,
        imagePutTimeoutMs: 80,
        ...over,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  const poolOf = (store: S3ObjectStore): Agent =>
    (store as unknown as { client: { transportAgent: Agent } }).client.transportAgent;

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(s => {
        s.closeAllConnections?.();
        return new Promise<void>(resolve => s.close(() => resolve()));
      }),
    );
  });

  it('frees the slot when a drained body never ends, with NO budget on the op at all', async () => {
    const { port } = await neverEndingBodyServer();
    const store = storeAt(port);
    // No signal: this is the caller the optional-signal port allows, and the one that
    // has nothing else to end the op.
    const outcome = await Promise.race([
      store.put('raw-html/x', Buffer.from('body'), { contentType: 'application/gzip' }).then(() => 'resolved', () => 'rejected'),
      new Promise<string>(resolve => setTimeout(() => resolve('HUNG'), 4_000)),
    ]);
    expect(outcome).toBe('rejected');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(Object.values(poolOf(store).sockets).flat()).toHaveLength(0);
  });

  it('sets the backstop ABOVE the longest op budget, so it never ends a live upload', () => {
    // The asset lane legitimately runs to 60 s on a 10 MiB original; a backstop at or
    // under that would silently cap it, which is the opposite of the bug being fixed.
    const base = { endpoint: 'https://x', region: 'r', bucket: 'b', prefix: 'p', keyScheme: 'sha256-v1' };
    expect(socketBackstopMs({ ...base, putTimeoutMs: 30_000, imagePutTimeoutMs: 60_000 })).toBeGreaterThan(60_000);
    expect(socketBackstopMs({ ...base, putTimeoutMs: 90_000, imagePutTimeoutMs: 10_000 })).toBeGreaterThan(90_000);
  });

  it('derives the backstop from the DEFAULTS when the config names no budgets', () => {
    expect(socketBackstopMs({ endpoint: 'https://x', region: 'r', bucket: 'b', prefix: 'p', keyScheme: 'sha256-v1' }))
      .toBeGreaterThan(DEFAULT_IMAGE_PUT_TIMEOUT_MS);
  });
});

/**
 * The drain list is a hand-maintained copy of an unexported minio constant, and drifting
 * from it is NOT graceful: a status minio retries on but we do not drain strands its
 * socket, and with as many concurrently failing ops as the pool has slots every retry
 * queues behind one that is never released — no op fails, so no failure path runs. In the
 * sink the op budgets degrade that to a stall rather than a death, but the protection is
 * gone. These are the guards that make a minio bump break CI instead of prod.
 */
describe('S3ObjectStore — the drain list is pinned to minio’s retry set', () => {
  const servers: http.Server[] = [];

  const statusServer = async (
    status: number | null,
  ): Promise<{ port: number; hits: () => number; connections: () => number }> => {
    let hits = 0;
    let conns = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      req.resume();
      req.once('end', () => {
        if (status === null) {
          res.writeHead(200, { ETag: '"x"' });
          res.end();
          return;
        }
        res.writeHead(status, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>Boom</Code></Error>');
      });
    });
    server.on('connection', () => {
      conns += 1;
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, hits: () => hits, connections: () => conns };
  };

  const storeAt = (port: number): S3ObjectStore =>
    new S3ObjectStore(
      'mindsignals-raw',
      {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'hel1',
        bucket: 'mindsignals-raw',
        prefix: 'raw-html/',
        keyScheme: 'sha256-v1',
        pathStyle: true,
        concurrency: 2,
      },
      { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    );

  const assignedOf = (store: S3ObjectStore): number =>
    Object.values((store as unknown as { client: { transportAgent: Agent } }).client.transportAgent.sockets).flat().length;
  const freeOf = (store: S3ObjectStore): number =>
    Object.values((store as unknown as { client: { transportAgent: Agent } }).client.transportAgent.freeSockets).flat().length;
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60));

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(s => {
        s.closeAllConnections?.();
        return new Promise<void>(resolve => s.close(() => resolve()));
      }),
    );
  });

  // The behavioural guard, one case per status minio retries on. If a future minio adds a
  // status to its set and this list is updated to match, the new case must pass here too —
  // and if the set is updated WITHOUT the drain working, this is where it shows.
  for (const status of [...MINIO_RETRYABLE_STATUSES]) {
    it(`returns the connection to the pool after a ${status}`, async () => {
      const { port, hits, connections } = await statusServer(status);
      const store = storeAt(port);
      await expect(
        store.put('raw-html/x', Buffer.from('body'), { contentType: 'application/gzip' }).then(() => 'ok', () => 'rej'),
      ).resolves.toBe('rej');
      expect(hits()).toBe(2); // the attempt plus minio's one retry
      expect(connections()).toBe(1); // …both served by ONE connection, because it comes back
      await settle();
      expect(assignedOf(store)).toBe(0);
      expect(freeOf(store)).toBe(1);
    });
  }

  it('control: a 200 keeps its connection warm, as it always did', async () => {
    const { port, connections } = await statusServer(null);
    const store = storeAt(port);
    await expect(
      store.put('raw-html/x', Buffer.from('body'), { contentType: 'application/gzip' }).then(() => 'ok', () => 'rej'),
    ).resolves.toBe('ok');
    expect(connections()).toBe(1);
    await settle();
    expect(assignedOf(store)).toBe(0);
    expect(freeOf(store)).toBe(1);
  });

  it('control: a 403 is NOT drained — minio reads that body itself to build its S3Error', async () => {
    const { port, hits } = await statusServer(403);
    const store = storeAt(port);
    // The proof it was NOT drained: minio parsed the body and carried its Code out.
    await expect(
      store.put('raw-html/x', Buffer.from('body'), { contentType: 'application/gzip' }),
    ).rejects.toMatchObject({ code: 'Boom' });
    expect(hits()).toBe(1); // not retryable, so no second attempt
    await settle();
    expect(assignedOf(store)).toBe(0);
  });

  it('control: a 404 HEAD still reads as absence, and holds no slot', async () => {
    // Its connection is NOT reused — that is minio's own error path and predates this
    // adapter (identical on upstream/develop); asserted here only as "holds nothing".
    const { port } = await statusServer(404);
    const store = storeAt(port);
    await expect(store.exists('raw-html/x')).resolves.toBe(false);
    await settle();
    expect(assignedOf(store)).toBe(0);
  });

  it('is exactly minio’s own retryHttpCodes — a bump that changes the set fails HERE', () => {
    // Read out of the installed package: minio's exports map blocks deep imports, so the
    // list cannot be pinned at runtime and is pinned in CI instead.
    const candidates = [
      join(process.cwd(), 'node_modules/minio/dist/main/internal/request.js'),
      join(process.cwd(), '../node_modules/minio/dist/main/internal/request.js'),
    ];
    const found = candidates.find(p => existsSync(p));
    expect(found).toBeDefined();
    const src = readFileSync(found as string, 'utf8');
    const block = /retryHttpCodes\s*(?::[^=]*)?=\s*\{([\s\S]*?)\}/.exec(src);
    // A shape change is itself a signal: look before assuming the set is unchanged.
    expect(block).not.toBeNull();
    const theirs = new Set((block as RegExpExecArray)[1].match(/\d+/g)?.map(Number) ?? []);
    expect(theirs.size).toBeGreaterThan(0);
    expect([...theirs].sort((a, b) => a - b)).toEqual([...MINIO_RETRYABLE_STATUSES].sort((a, b) => a - b));
  });
});
