/**
 * S3ObjectStore — the concrete Hetzner-Object-Storage adapter for the ObjectStore
 * port, plus the env-driven factory that wires the real CaptureSink (or a Noop
 * when capture is not configured).
 *
 * Config comes from the environment per the ratified raw-store contract
 * (fc-infra nodes/fc-app-01/raw-store/raw-store-config.yaml + the synced Secret):
 *   RAW_STORE_S3_ENDPOINT / _REGION / _BUCKET / _PREFIX / _KEY_SCHEME  (ConfigMap)
 *   ACCESS_KEY_ID / SECRET_ACCESS_KEY                                   (Secret)
 * The scraper reads env — it never talks to OpenBao itself (the infra syncs the
 * credential into the deployment's environment).
 *
 * This adapter is thin glue over minio and is validated at deploy (a live PUT/HEAD
 * against the bucket), not in unit tests — the sink logic is exercised against a
 * fake ObjectStore in objectStoreCaptureSink.test.ts.
 */
import { Client as MinioClient } from 'minio';
import type { CaptureSink } from './captureSink.js';
import { NoopCaptureSink } from './captureSink.js';
import {
  ObjectStoreCaptureSink,
  type ObjectStore,
  type PutOptions,
  type RawStoreConfig,
} from './objectStoreCaptureSink.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Maps the minimal ObjectStore port onto the minio client (statObject / putObject). */
export class S3ObjectStore implements ObjectStore {
  private readonly client: MinioClient;

  constructor(
    private readonly bucket: string,
    config: RawStoreConfig,
    creds: S3Credentials,
  ) {
    const url = new URL(config.endpoint);
    this.client = new MinioClient({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      useSSL: url.protocol === 'https:',
      region: config.region,
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
      pathStyle: config.pathStyle ?? false, // Hetzner = virtual-hosted style
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key);
      return true;
    } catch (err) {
      // A genuine 404 means "not stored yet" — NOT a failure. Any other error
      // (network, auth, 5xx) is a real fault: rethrow so the sink counts it and
      // does not mistake it for absence (which would trigger a needless re-PUT).
      const e = err as { code?: string; statusCode?: number };
      if (e?.code === 'NotFound' || e?.code === 'NoSuchKey' || e?.statusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async put(key: string, body: Buffer, opts: PutOptions): Promise<void> {
    const metaData: Record<string, string> = { 'Content-Type': opts.contentType };
    for (const [k, v] of Object.entries(opts.metadata ?? {})) {
      metaData[`x-amz-meta-${k}`] = v;
    }
    await this.client.putObject(this.bucket, key, body, body.length, metaData);
  }
}

/**
 * Reads the raw-store contract + credential from the environment. Returns null
 * when capture is not configured (any required value missing) → the caller
 * falls back to a NoopCaptureSink (feature off).
 */
export function loadRawStoreConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { config: RawStoreConfig; creds: S3Credentials } | null {
  const endpoint = env.RAW_STORE_S3_ENDPOINT;
  const bucket = env.RAW_STORE_S3_BUCKET;
  const accessKeyId = env.ACCESS_KEY_ID;
  const secretAccessKey = env.SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  const config: RawStoreConfig = {
    endpoint,
    region: env.RAW_STORE_S3_REGION ?? 'us-east-1',
    bucket,
    prefix: env.RAW_STORE_S3_PREFIX ?? 'raw-html/',
    keyScheme: env.RAW_STORE_KEY_SCHEME ?? 'sha256-v1',
    putTimeoutMs: env.RAW_STORE_PUT_TIMEOUT_MS ? Number(env.RAW_STORE_PUT_TIMEOUT_MS) : undefined,
    pathStyle: env.RAW_STORE_S3_PATH_STYLE !== undefined ? env.RAW_STORE_S3_PATH_STYLE === 'true' : undefined,
  };
  return { config, creds: { accessKeyId, secretAccessKey } };
}

/**
 * The composition-root factory: a real content-addressed sink when the raw-store
 * env is present, otherwise a NoopCaptureSink. Constructing the sink asserts the
 * key scheme (fail-fast on a misconfigured contract version).
 */
export function createRawCaptureSink(env: NodeJS.ProcessEnv = process.env): CaptureSink {
  const loaded = loadRawStoreConfigFromEnv(env);
  if (!loaded) return new NoopCaptureSink();
  const store = new S3ObjectStore(loaded.config.bucket, loaded.config, loaded.creds);
  return new ObjectStoreCaptureSink(store, loaded.config);
}

// Process-wide singleton so every fetch path shares one client + one set of
// observable counters. Lazily built from the environment on first use.
let sharedSink: CaptureSink | undefined;
export function getRawCaptureSink(): CaptureSink {
  if (!sharedSink) sharedSink = createRawCaptureSink();
  return sharedSink;
}
