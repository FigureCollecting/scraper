import { NoopCaptureSink } from '../../services/captureSink';
import { ObjectStoreCaptureSink } from '../../services/objectStoreCaptureSink';
import { loadRawStoreConfigFromEnv, createRawCaptureSink } from '../../services/s3ObjectStore';

const FULL_ENV = {
  RAW_STORE_S3_ENDPOINT: 'https://hel1.your-objectstorage.com',
  RAW_STORE_S3_REGION: 'hel1',
  RAW_STORE_S3_BUCKET: 'mindsignals-raw',
  RAW_STORE_S3_PREFIX: 'raw-html/',
  RAW_STORE_KEY_SCHEME: 'sha256-v1',
  ACCESS_KEY_ID: 'AKIAEXAMPLE',
  SECRET_ACCESS_KEY: 'secret-example',
} as unknown as NodeJS.ProcessEnv;

describe('loadRawStoreConfigFromEnv', () => {
  it('parses the full contract + credential from env', () => {
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

  it('returns null when any required value is missing (feature off)', () => {
    for (const drop of ['RAW_STORE_S3_ENDPOINT', 'RAW_STORE_S3_BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
      const env = { ...FULL_ENV };
      delete (env as Record<string, unknown>)[drop];
      expect(loadRawStoreConfigFromEnv(env)).toBeNull();
    }
  });

  it('defaults prefix/keyScheme when omitted', () => {
    const env = { ...FULL_ENV } as Record<string, unknown>;
    delete env.RAW_STORE_S3_PREFIX;
    delete env.RAW_STORE_KEY_SCHEME;
    const loaded = loadRawStoreConfigFromEnv(env as NodeJS.ProcessEnv)!;
    expect(loaded.config.prefix).toBe('raw-html/');
    expect(loaded.config.keyScheme).toBe('sha256-v1');
  });
});

describe('createRawCaptureSink', () => {
  it('returns a NoopCaptureSink when capture is not configured', () => {
    expect(createRawCaptureSink({} as NodeJS.ProcessEnv)).toBeInstanceOf(NoopCaptureSink);
  });

  it('returns a real ObjectStoreCaptureSink when configured', () => {
    expect(createRawCaptureSink(FULL_ENV)).toBeInstanceOf(ObjectStoreCaptureSink);
  });

  it('fails fast on an unknown key scheme rather than silently dropping captures', () => {
    const env = { ...FULL_ENV, RAW_STORE_KEY_SCHEME: 'sha256-v2' } as unknown as NodeJS.ProcessEnv;
    expect(() => createRawCaptureSink(env)).toThrow(/sha256-v1/);
  });
});
