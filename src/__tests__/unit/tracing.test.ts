import { shouldEnableTracing } from '../../tracing';

/**
 * Importing src/tracing runs its module side effect (startTracing), which is a
 * no-op here because jest sets NODE_ENV=test — so these tests exercise only the
 * pure gate decision, with no SDK started.
 */
describe('shouldEnableTracing', () => {
  it('is disabled under the test environment', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'test' })).toBe(false);
  });

  it('never traces the suite even if explicitly enabled', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'test', OTEL_TRACES_ENABLED: 'true' })).toBe(false);
  });

  it('treats OTEL_TRACES_ENABLED=false as a kill switch anywhere', () => {
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false', NODE_ENV: 'development' })).toBe(false);
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false', NODE_ENV: 'production' })).toBe(false);
    expect(shouldEnableTracing({ OTEL_TRACES_ENABLED: 'false' })).toBe(false);
  });

  it('defaults on everywhere outside test — production included', () => {
    expect(shouldEnableTracing({ NODE_ENV: 'development' })).toBe(true);
    expect(shouldEnableTracing({})).toBe(true);
    expect(shouldEnableTracing({ NODE_ENV: 'production' })).toBe(true);
    expect(shouldEnableTracing({ NODE_ENV: 'production', OTEL_TRACES_ENABLED: 'true' })).toBe(true);
  });
});
