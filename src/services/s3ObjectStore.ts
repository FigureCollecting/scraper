/**
 * S3ObjectStore — the concrete Hetzner-Object-Storage adapter for the ObjectStore
 * port, plus the env-driven factory that wires the real CaptureSink (or a Noop
 * when capture is not configured).
 *
 * Config comes from the environment per the ratified raw-store contract
 * (fc-infra nodes/fc-app-01/raw-store/README.md — the "1.B scraper Deployment
 * wiring" fragment):
 *   PERSIST_RAW_HTML=true                                        (the se-09 kill-switch)
 *   PERSIST_RAW_IMAGES=true                                      (the SEPARATE asset-lane switch)
 *   RAW_STORE_S3_ENDPOINT / _REGION / _BUCKET / _PREFIX / _KEY_SCHEME   (ConfigMap, envFrom)
 *   RAW_STORE_S3_ACCESS_KEY_ID / RAW_STORE_S3_SECRET_ACCESS_KEY   (Secret raw-store-s3-creds,
 *       whose internal keys are ACCESS_KEY_ID/SECRET_ACCESS_KEY, mapped to these
 *       prefixed env-var names via secretKeyRef — the process sees the prefixed names)
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
  type SinkStats,
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
    await this.client.putObject(this.bucket, key, body, body.length, toS3MetaData(opts));
  }
}

/**
 * The exact header set handed to S3: `Content-Type` + `x-amz-meta-*` user metadata,
 * and deliberately NO `Content-Encoding` (the `.gz` suffix declares compression).
 * Exported so the real header boundary is unit-tested without a live client.
 */
export function toS3MetaData(opts: PutOptions): Record<string, string> {
  const metaData: Record<string, string> = { 'Content-Type': opts.contentType };
  for (const [k, v] of Object.entries(opts.metadata ?? {})) {
    metaData[`x-amz-meta-${k}`] = v;
  }
  return metaData;
}

/** A finite, positive number from env, or undefined (the sink uses its default). */
function parsePositive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The asset lane's own kill switch, deliberately SEPARATE from PERSIST_RAW_HTML:
 * images are a different corpus with different volume and different rights, so
 * turning page capture on must not start pulling binaries. Off unless the value is
 * exactly `true`, and consulted by the caller that decides to fetch an image at all
 * — the sink itself stores whatever it is handed.
 */
export function isImagePersistenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PERSIST_RAW_IMAGES === 'true';
}

/** Names the switch(es) that were turned on, for the enabled-but-incomplete warning. */
function enabledSwitches(pages: boolean, assets: boolean): string {
  const on = [pages ? 'PERSIST_RAW_HTML=true' : '', assets ? 'PERSIST_RAW_IMAGES=true' : ''].filter(Boolean);
  return on.join(' + ');
}

/**
 * Reads the raw-store contract + credential from the environment. Returns null
 * when BOTH capture switches are off, or the config is incomplete.
 *
 * Either switch on its own builds the sink: the asset lane is genuinely independent
 * of page capture (a different corpus, different volume, different rights), so an
 * images-only wiring must not silently collapse to a Noop. Which LANES may then
 * write is carried into the config as pagesEnabled/assetsEnabled and enforced at
 * the sink's write boundary.
 *
 * An ENABLED-but-incomplete state is logged loudly — never a silent Noop — because
 * a name/wiring mismatch would otherwise disable the (irrecoverable) insurance
 * corpus with no signal.
 */
export function loadRawStoreConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { config: RawStoreConfig; creds: S3Credentials } | null {
  // se-09 kill-switches: capture is off by default; absence here is intended silence.
  const pagesEnabled = env.PERSIST_RAW_HTML === 'true';
  const assetsEnabled = isImagePersistenceEnabled(env);
  if (!pagesEnabled && !assetsEnabled) return null;

  const endpoint = env.RAW_STORE_S3_ENDPOINT;
  const bucket = env.RAW_STORE_S3_BUCKET;
  const accessKeyId = env.RAW_STORE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.RAW_STORE_S3_SECRET_ACCESS_KEY;

  const missing = [
    ['RAW_STORE_S3_ENDPOINT', endpoint],
    ['RAW_STORE_S3_BUCKET', bucket],
    ['RAW_STORE_S3_ACCESS_KEY_ID', accessKeyId],
    ['RAW_STORE_S3_SECRET_ACCESS_KEY', secretAccessKey],
  ].filter(([, v]) => !v).map(([k]) => k as string);

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[RAW-STORE] ${enabledSwitches(pagesEnabled, assetsEnabled)} but required config/credentials are missing — capture DISABLED ` +
        `(needs RAW_STORE_S3_ENDPOINT, RAW_STORE_S3_BUCKET, RAW_STORE_S3_ACCESS_KEY_ID, RAW_STORE_S3_SECRET_ACCESS_KEY; missing: ${missing.join(', ')})`,
    );
    return null;
  }

  const config: RawStoreConfig = {
    endpoint,
    region: env.RAW_STORE_S3_REGION ?? 'us-east-1',
    bucket,
    prefix: env.RAW_STORE_S3_PREFIX ?? 'raw-html/',
    jsonPrefix: env.RAW_STORE_S3_JSON_PREFIX ?? 'raw-json/',
    imagePrefix: env.RAW_STORE_S3_IMAGE_PREFIX ?? 'raw-img/',
    keyScheme: env.RAW_STORE_KEY_SCHEME ?? 'sha256-v1',
    pagesEnabled,
    assetsEnabled,
    putTimeoutMs: parsePositive(env.RAW_STORE_PUT_TIMEOUT_MS),
    imagePutTimeoutMs: parsePositive(env.RAW_STORE_IMAGE_PUT_TIMEOUT_MS),
    maxImageBytes: parsePositive(env.RAW_STORE_IMAGE_MAX_BYTES),
    pathStyle: env.RAW_STORE_S3_PATH_STYLE !== undefined ? env.RAW_STORE_S3_PATH_STYLE === 'true' : undefined,
  };
  return { config, creds: { accessKeyId, secretAccessKey } };
}

/**
 * The composition-root factory: a real content-addressed sink when the raw-store
 * env is present and enabled, otherwise a NoopCaptureSink. Constructing the sink
 * asserts the key scheme (fail-fast on a misconfigured contract version).
 */
export function createRawCaptureSink(env: NodeJS.ProcessEnv = process.env): CaptureSink {
  const loaded = loadRawStoreConfigFromEnv(env);
  if (!loaded) return new NoopCaptureSink();
  const store = new S3ObjectStore(loaded.config.bucket, loaded.config, loaded.creds);
  return new ObjectStoreCaptureSink(store, loaded.config);
}

/**
 * The ops-readable view of whichever sink the composition root built. `configured`
 * separates "no sink at all" (both switches off / incomplete config) from a live
 * one, and the counters make an all-skipping asset lane — every image answered with
 * a challenge page, say — visible instead of looking exactly like an idle one.
 */
export interface RawStoreView {
  configured: boolean;
  stats?: SinkStats;
}

/** Duck-typed: only a real sink carries stats(). Never throws — health reads this. */
export function rawStoreView(sink: CaptureSink = getRawCaptureSink()): RawStoreView {
  const s = sink as { stats?: () => SinkStats };
  if (typeof s.stats !== 'function') return { configured: false };
  try {
    return { configured: true, stats: s.stats() };
  } catch {
    return { configured: false };
  }
}

// Process-wide singleton so every fetch path shares one client + one set of
// observable counters. Lazily built from the environment on first use.
let sharedSink: CaptureSink | undefined;
export function getRawCaptureSink(): CaptureSink {
  if (!sharedSink) sharedSink = createRawCaptureSink();
  return sharedSink;
}
