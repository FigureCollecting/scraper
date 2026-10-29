import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';

/**
 * service.version on the server's trace resource. startTracing runs for real against the env it is given;
 * only the SDK and the auto-instrumentations are faked, so nothing is patched, started or exported, and
 * the test reads the resource startTracing built.
 */
const mockSdkConfigs: Array<Partial<NodeSDKConfiguration>> = [];

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(config: Partial<NodeSDKConfiguration>) {
      mockSdkConfigs.push(config);
    }
    start(): void {}
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations: () => [] }));

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
/** Not this package's version: npm and npx put the real one in process.env, which must not be what passes. */
const NPM_VERSION = '9.9.9';
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Starts tracing in a fresh copy of the module (it keeps one SDK per process) and returns the resource's version. */
function traceVersion(env: NodeJS.ProcessEnv): unknown {
  let startTracing: (env: NodeJS.ProcessEnv) => unknown = () => undefined;
  jest.isolateModules(() => {
    ({ startTracing } = require('../../tracing'));
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const before = new Map(SIGNALS.map(signal => [signal, process.listeners(signal)]));
  mockSdkConfigs.length = 0;
  try {
    startTracing(env);
  } finally {
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)?.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
  expect(mockSdkConfigs).toHaveLength(1);
  return mockSdkConfigs[0].resource?.attributes['service.version'];
}

describe('service.version on the trace resource', () => {
  it('is SERVICE_VERSION when it is set, ahead of npm_package_version', () => {
    expect(traceVersion({ SERVICE_VERSION: COMMIT, npm_package_version: NPM_VERSION })).toBe(COMMIT);
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' \t '],
  ])('falls back to npm_package_version when SERVICE_VERSION is %s', (_what, blank) => {
    expect(traceVersion({ SERVICE_VERSION: blank, npm_package_version: NPM_VERSION })).toBe(NPM_VERSION);
  });

  it("is 'unknown' when neither is set, the value fc-shared's log lines and job spans carry", () => {
    expect(traceVersion({ SERVICE_VERSION: ' ' })).toBe('unknown');
  });

  it('reads the env it is given, not process.env', () => {
    const saved = { SERVICE_VERSION: process.env.SERVICE_VERSION, npm_package_version: process.env.npm_package_version };
    process.env.SERVICE_VERSION = 'from-process-env';
    process.env.npm_package_version = 'from-process-env';
    try {
      expect(traceVersion({ npm_package_version: NPM_VERSION })).toBe(NPM_VERSION);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
