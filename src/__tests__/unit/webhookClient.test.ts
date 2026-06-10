/**
 * Unit tests for Webhook Client
 *
 * The network connection is faked with MSW (msw/node) — the real `fetch`,
 * URL shaping, HMAC signing, status handling, and retry/backoff all run; only
 * the socket is intercepted. Per the testing doctrine, never replace `fetch`
 * itself (`global.fetch = jest.fn()`), which would skip exactly the code that
 * breaks in production.
 */
import crypto from 'crypto';
import { http, HttpResponse } from 'msw';
import { server, installMswServer } from '../msw/server';
import {
  registerWebhookConfig,
  unregisterWebhookConfig,
  getWebhookConfig,
  notifyItemComplete,
  notifyPhaseChange,
  notifyListsSync,
  notifyItemSuccess,
  notifyItemFailed,
  notifyItemSkipped,
  webhookRetryConfig,
  WebhookConfig,
  ItemCompletePayload,
  PhaseChangePayload,
  ListsSyncPayload,
} from '../../services/webhookClient';

// Default webhook base URL the client builds requests against
// (TRUSTED_WEBHOOK_BASE_URL falls back to this when no env var is set).
const BASE = 'http://localhost:5080/sync/webhook';

const jsonResponse = (status: number, body: unknown) =>
  new HttpResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

installMswServer();

describe('webhookClient', () => {
  const testConfig: WebhookConfig = {
    webhookUrl: 'http://localhost:5000/api/webhooks',
    webhookSecret: 'test-secret-key-123',
    sessionId: 'session-abc-123',
  };

  const originalRetryConfig = { ...webhookRetryConfig };

  beforeEach(() => {
    // Near-zero backoff keeps the retry-count/outcome tests fast and deterministic.
    // These tests assert the number of attempts and the final result, not the
    // backoff *schedule*, so the delay magnitude is irrelevant to what they check.
    webhookRetryConfig.baseDelayMs = 1;
    webhookRetryConfig.maxRetries = 3;
    unregisterWebhookConfig('session-abc-123');
    unregisterWebhookConfig('session-xyz-789');
  });

  afterEach(() => {
    webhookRetryConfig.baseDelayMs = originalRetryConfig.baseDelayMs;
    webhookRetryConfig.maxRetries = originalRetryConfig.maxRetries;
  });

  describe('registerWebhookConfig', () => {
    it('should register a webhook configuration', () => {
      registerWebhookConfig(testConfig);
      expect(getWebhookConfig('session-abc-123')).toEqual(testConfig);
    });

    it('should overwrite existing config for same sessionId', () => {
      registerWebhookConfig(testConfig);
      registerWebhookConfig({ ...testConfig, webhookSecret: 'new-secret' });
      expect(getWebhookConfig('session-abc-123')?.webhookSecret).toBe('new-secret');
    });
  });

  describe('unregisterWebhookConfig', () => {
    it('should remove a webhook configuration', () => {
      registerWebhookConfig(testConfig);
      unregisterWebhookConfig('session-abc-123');
      expect(getWebhookConfig('session-abc-123')).toBeUndefined();
    });

    it('should not throw when removing non-existent config', () => {
      expect(() => unregisterWebhookConfig('non-existent')).not.toThrow();
    });
  });

  describe('getWebhookConfig', () => {
    it('should return undefined for unknown sessionId', () => {
      expect(getWebhookConfig('unknown-session')).toBeUndefined();
    });

    it('should return the registered config', () => {
      registerWebhookConfig(testConfig);
      expect(getWebhookConfig('session-abc-123')).toEqual(testConfig);
    });
  });

  describe('notifyItemComplete', () => {
    it('should return false when no webhook config registered', async () => {
      // No handler registered + onUnhandledRequest:'error' means if the client
      // erroneously issued a request, the test would fail loudly. It must not.
      const payload: ItemCompletePayload = {
        sessionId: 'unknown-session',
        mfcId: '12345',
        status: 'completed',
      };
      expect(await notifyItemComplete(payload)).toBe(false);
    });

    it('posts to the item-complete endpoint with a valid HMAC-SHA256 signature', async () => {
      registerWebhookConfig(testConfig);

      let captured: { url: string; method: string; contentType: string | null; signature: string | null; body: string } | undefined;
      server.use(
        http.post(`${BASE}/item-complete`, async ({ request }) => {
          captured = {
            url: request.url,
            method: request.method,
            contentType: request.headers.get('content-type'),
            signature: request.headers.get('x-webhook-signature'),
            body: await request.text(),
          };
          return HttpResponse.json({ success: true });
        }),
      );

      const payload: ItemCompletePayload = {
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
        scrapedData: { name: 'Test Figure' },
      };

      expect(await notifyItemComplete(payload)).toBe(true);
      expect(captured?.url).toBe(`${BASE}/item-complete`);
      expect(captured?.method).toBe('POST');
      expect(captured?.contentType).toBe('application/json');

      // Verify the REAL signature: independently recompute the HMAC over the exact
      // body the client sent. A bug in signPayload would now fail this test.
      const expectedSig = crypto
        .createHmac('sha256', testConfig.webhookSecret)
        .update(captured!.body)
        .digest('hex');
      expect(captured?.signature).toBe(expectedSig);
      expect(JSON.parse(captured!.body)).toMatchObject({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
        scrapedData: { name: 'Test Figure' },
      });
    });

    it('should retry on 500 and return false after exhausting retries', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/item-complete`, () => {
          calls++;
          return jsonResponse(500, { message: 'Internal Server Error' });
        }),
      );

      const result = await notifyItemComplete({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'failed',
        error: 'scrape failed',
      });

      expect(result).toBe(false);
      expect(calls).toBe(4); // 1 initial + 3 retries
    });

    it('should retry on network error and return false after exhausting retries', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/item-complete`, () => {
          calls++;
          return HttpResponse.error(); // simulated network failure -> fetch rejects
        }),
      );

      const result = await notifyItemComplete({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(calls).toBe(4);
    });

    it('should retry on 429 and succeed when backend recovers', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/item-complete`, () => {
          calls++;
          return calls === 1
            ? jsonResponse(429, { message: 'Too many requests' })
            : HttpResponse.json({ success: true });
        }),
      );

      const result = await notifyItemComplete({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
      });

      expect(result).toBe(true);
      expect(calls).toBe(2);
    });

    it('should not retry on 4xx errors other than 429', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/item-complete`, () => {
          calls++;
          return jsonResponse(401, { message: 'Unauthorized' });
        }),
      );

      const result = await notifyItemComplete({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(calls).toBe(1); // no retries for 401
    });

    it('should handle json parse failure in error response after retries', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/item-complete`, () => {
          calls++;
          // 502 is retryable; non-JSON body makes the final response.json() throw,
          // which the client catches via .catch(() => ({})).
          return new HttpResponse('not json', { status: 502 });
        }),
      );

      const result = await notifyItemComplete({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
      });

      expect(result).toBe(false);
      expect(calls).toBe(4); // 1 initial + 3 retries
    });

    it('honors the Retry-After header (retries then succeeds)', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/item-complete`, () => {
          calls++;
          // Retry-After present exercises the header-honoring branch; value '0'
          // keeps it deterministic with no real delay.
          return calls === 1
            ? new HttpResponse(JSON.stringify({ message: 'Rate limited' }), {
                status: 429,
                headers: { 'content-type': 'application/json', 'retry-after': '0' },
              })
            : HttpResponse.json({ success: true });
        }),
      );

      const result = await notifyItemComplete({
        sessionId: 'session-abc-123',
        mfcId: '12345',
        status: 'completed',
      });

      expect(result).toBe(true);
      expect(calls).toBe(2);
    });
  });

  describe('notifyPhaseChange', () => {
    it('should return false when no webhook config registered', async () => {
      const payload: PhaseChangePayload = {
        sessionId: 'unknown-session',
        phase: 'validating',
        message: 'Validating cookies',
      };
      expect(await notifyPhaseChange(payload)).toBe(false);
    });

    it('should send phase change notification to the phase-change endpoint', async () => {
      registerWebhookConfig(testConfig);
      let capturedUrl: string | undefined;
      server.use(
        http.post(`${BASE}/phase-change`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ success: true });
        }),
      );

      const payload: PhaseChangePayload = {
        sessionId: 'session-abc-123',
        phase: 'queueing',
        message: 'Queueing 50 items',
        items: [{ mfcId: '123', name: 'Figure 1', collectionStatus: 'owned', isNsfw: false }],
      };

      expect(await notifyPhaseChange(payload)).toBe(true);
      expect(capturedUrl).toBe(`${BASE}/phase-change`);
    });
  });

  describe('notifyListsSync', () => {
    it('should return false when no webhook config registered', async () => {
      const payload: ListsSyncPayload = {
        sessionId: 'unknown-session',
        lists: [{ mfcId: 100, name: 'Wishlist', privacy: 'public', itemCount: 5 }],
      };
      expect(await notifyListsSync(payload)).toBe(false);
    });

    it('should send lists sync webhook with correct endpoint and payload', async () => {
      registerWebhookConfig(testConfig);
      let captured: { url: string; method: string; contentType: string | null; signature: string | null; body: string } | undefined;
      server.use(
        http.post(`${BASE}/lists-sync`, async ({ request }) => {
          captured = {
            url: request.url,
            method: request.method,
            contentType: request.headers.get('content-type'),
            signature: request.headers.get('x-webhook-signature'),
            body: await request.text(),
          };
          return HttpResponse.json({ success: true });
        }),
      );

      const payload: ListsSyncPayload = {
        sessionId: 'session-abc-123',
        lists: [
          {
            mfcId: 100,
            name: 'My Wishlist',
            teaser: 'Figures I want',
            privacy: 'public',
            iconUrl: 'https://static.myfigurecollection.net/icon.jpg',
            itemCount: 12,
            itemMfcIds: [1001, 1002, 1003],
            mfcCreatedAt: '2024-01-15',
          },
          { mfcId: 200, name: 'Private Collection', privacy: 'private', itemCount: 3 },
        ],
      };

      expect(await notifyListsSync(payload)).toBe(true);
      expect(captured?.url).toBe(`${BASE}/lists-sync`);
      expect(captured?.method).toBe('POST');
      expect(captured?.contentType).toBe('application/json');
      expect(captured?.signature).toBeTruthy();

      const body = JSON.parse(captured!.body);
      expect(body.sessionId).toBe('session-abc-123');
      expect(body.lists).toHaveLength(2);
      expect(body.lists[0].mfcId).toBe(100);
      expect(body.lists[0].name).toBe('My Wishlist');
      expect(body.lists[0].teaser).toBe('Figures I want');
      expect(body.lists[0].privacy).toBe('public');
      expect(body.lists[0].iconUrl).toBe('https://static.myfigurecollection.net/icon.jpg');
      expect(body.lists[0].itemCount).toBe(12);
      expect(body.lists[0].itemMfcIds).toEqual([1001, 1002, 1003]);
      expect(body.lists[0].mfcCreatedAt).toBe('2024-01-15');
      expect(body.lists[1].mfcId).toBe(200);
      expect(body.lists[1].privacy).toBe('private');
    });

    it('should retry on server error and return false after exhausting retries', async () => {
      registerWebhookConfig(testConfig);
      let calls = 0;
      server.use(
        http.post(`${BASE}/lists-sync`, () => {
          calls++;
          return jsonResponse(503, { message: 'Service Unavailable' });
        }),
      );

      const result = await notifyListsSync({
        sessionId: 'session-abc-123',
        lists: [{ mfcId: 100, name: 'Test List', privacy: 'public', itemCount: 1 }],
      });

      expect(result).toBe(false);
      expect(calls).toBe(4); // 1 initial + 3 retries
    });
  });

  describe('notifyItemSuccess', () => {
    it('should call notifyItemComplete with completed status', async () => {
      registerWebhookConfig(testConfig);
      let body: any;
      server.use(
        http.post(`${BASE}/item-complete`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ success: true });
        }),
      );

      expect(await notifyItemSuccess('session-abc-123', '12345', { name: 'Test' })).toBe(true);
      expect(body.status).toBe('completed');
      expect(body.mfcId).toBe('12345');
      expect(body.scrapedData).toEqual({ name: 'Test' });
    });

    it('should work without scrapedData', async () => {
      registerWebhookConfig(testConfig);
      server.use(http.post(`${BASE}/item-complete`, () => HttpResponse.json({ success: true })));
      expect(await notifyItemSuccess('session-abc-123', '12345')).toBe(true);
    });

    it('should return false when no config registered', async () => {
      expect(await notifyItemSuccess('unknown', '12345')).toBe(false);
    });
  });

  describe('notifyItemFailed', () => {
    it('should call notifyItemComplete with failed status', async () => {
      registerWebhookConfig(testConfig);
      let body: any;
      server.use(
        http.post(`${BASE}/item-complete`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ success: true });
        }),
      );

      expect(await notifyItemFailed('session-abc-123', '12345', 'timeout error')).toBe(true);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('timeout error');
    });
  });

  describe('notifyItemSkipped', () => {
    it('should call notifyItemComplete with skipped status', async () => {
      registerWebhookConfig(testConfig);
      let body: any;
      server.use(
        http.post(`${BASE}/item-complete`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ success: true });
        }),
      );

      expect(await notifyItemSkipped('session-abc-123', '12345')).toBe(true);
      expect(body.status).toBe('skipped');
    });
  });
});
