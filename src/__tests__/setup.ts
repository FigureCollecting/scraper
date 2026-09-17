// Global test setup
import { jest } from '@jest/globals';
import { resetAllMocks } from './__mocks__/puppeteer';

// Mock console methods to reduce test noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: console.error, // Keep error for debugging
};

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Use random port for tests

// Global test timeout
jest.setTimeout(30000);

// Docker container for integration tests
export async function createMockDockerContainer() {
  const { GenericContainer } = await import('testcontainers');
  
  const container = await new GenericContainer('node:16')
    .withExposedPorts(3001)
    .start();

  return {
    container,
    port: container.getMappedPort(3001),
    stop: async () => {
      await container.stop();
    }
  };
}

// Reset all mocks before each test
beforeEach(() => {
  resetAllMocks();
  jest.clearAllMocks();
});

/**
 * Never let a fake clock outlive the test that installed it.
 *
 * A test that calls `jest.useFakeTimers()` and then times out is ABANDONED: the async
 * function never resumes, so its own `finally { jest.useRealTimers() }` never runs and
 * the fake clock stays installed. Every later test in that file then awaits a timer
 * nothing will ever advance, times out at 30 s in turn, and one flaky test becomes a
 * file that needs hours. That cascade is what ran this repo's CI job to GitHub's
 * 6-hour cap (objectStoreCaptureSink.test.ts, 2026-09-11 to 2026-09-15).
 *
 * afterEach still runs after a timed-out test, so restoring here keeps the damage to
 * the one test that actually broke. Files that install fake timers in their own
 * beforeEach are unaffected: that hook re-installs them for the next test.
 */
afterEach(() => {
  jest.useRealTimers();
});