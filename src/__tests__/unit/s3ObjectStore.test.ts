import { jest } from '@jest/globals';
import { NoopCaptureSink } from '../../services/captureSink';
import { ObjectStoreCaptureSink } from '../../services/objectStoreCaptureSink';
import {
  loadRawStoreConfigFromEnv,
  createRawCaptureSink,
  isImagePersistenceEnabled,
  toS3MetaData,
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
