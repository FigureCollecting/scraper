import { createRuntimeConfig } from '../../../services/engineServices/runtimeConfig';

describe('createRuntimeConfig (env-backed RuntimeConfig)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns undefined for a key with no matching env var', () => {
    const config = createRuntimeConfig();
    expect(config.get('vndb.apiToken')).toBeUndefined();
  });

  it('reads a dotted key from the uppercased, underscored env var', () => {
    process.env.VNDB_APITOKEN = 'shh';
    const config = createRuntimeConfig();
    expect(config.get('vndb.apiToken')).toBe('shh');
  });

  it('JSON-parses env values that are valid JSON (booleans/numbers)', () => {
    process.env.SOME_FLAG = 'true';
    process.env.SOME_LIMIT = '42';
    const config = createRuntimeConfig();
    expect(config.get('some.flag')).toBe(true);
    expect(config.get('some.limit')).toBe(42);
  });

  it('falls back to the raw string when the env value is not valid JSON', () => {
    process.env.SOME_NAME = 'not-json-just-text';
    const config = createRuntimeConfig();
    expect(config.get('some.name')).toBe('not-json-just-text');
  });

  it('getFeatureFlag returns true only when the env var is exactly "true"', () => {
    process.env.FEATURE_MFC_STEALTH = 'true';
    process.env.FEATURE_MFC_LEGACY = 'false';
    const config = createRuntimeConfig();

    expect(config.getFeatureFlag('mfc', 'stealth')).toBe(true);
    expect(config.getFeatureFlag('mfc', 'legacy')).toBe(false);
  });

  it('getFeatureFlag returns false when the flag env var is unset', () => {
    const config = createRuntimeConfig();
    expect(config.getFeatureFlag('unknownsite', 'unknownfeature')).toBe(false);
  });
});
