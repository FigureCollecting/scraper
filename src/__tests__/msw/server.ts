/**
 * Shared MSW (Mock Service Worker) server for faking the network connection.
 *
 * Per the testing doctrine: fake the network *connection*, not the client.
 * The real `fetch` in webhookClient.ts issues a real request that MSW intercepts,
 * so URL shaping, headers, HMAC signing, status handling, and retry logic all run.
 *
 * `installMswServer()` wires the lifecycle into a describe block:
 *   - listen with onUnhandledRequest:'error' so any un-mocked request fails loudly
 *     (this is what turns a faked connection into a contract test)
 *   - resetHandlers after each test (handler state lives outside jest's mock registry,
 *     so jest's resetMocks does NOT clear it)
 *   - close after all tests
 */
import { setupServer } from 'msw/node';

export const server = setupServer();

export function installMswServer(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}
