/**
 * Webhook Client - Calls backend webhooks when items complete
 *
 * The scraper service uses this client to notify the backend of:
 * - Phase changes (validating, exporting, parsing, queueing, enriching, completed)
 * - Item completions (success or failure)
 *
 * Security:
 * - All webhook calls are signed with HMAC-SHA256
 * - Webhook secrets are provided per-session by the backend
 * - Secrets are ephemeral (not persisted) and expire with the session
 */

import crypto from 'crypto';

/**
 * Webhook configuration for a sync session.
 * Received from backend when sync job is created.
 */
export interface WebhookConfig {
  webhookUrl: string;
  webhookSecret: string;
  sessionId: string;
}

/**
 * Item status for webhook callbacks.
 */
export type ItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

/**
 * Item completion payload.
 */
export interface ItemCompletePayload {
  sessionId: string;
  mfcId: string;
  status: ItemStatus;
  error?: string;
  scrapedData?: Record<string, unknown>;
}

/**
 * Phase change payload.
 */
export interface PhaseChangePayload {
  sessionId: string;
  phase: string;
  message?: string;
  items?: Array<{
    mfcId: string;
    name?: string;
    collectionStatus: string;
    isNsfw?: boolean;
  }>;
}

// Store webhook configs by sessionId
const webhookConfigs = new Map<string, WebhookConfig>();

/**
 * Trusted webhook base URL from environment configuration.
 * This breaks the SSRF taint chain by using a server-controlled value
 * rather than user-provided input for the fetch URL.
 * Falls back to the backend's default local dev URL.
 */
const TRUSTED_WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL
  || (process.env.BACKEND_URL ? `${process.env.BACKEND_URL}/sync/webhook` : null)
  || 'http://localhost:5080/sync/webhook';

/**
 * Register a webhook configuration for a sync session.
 */
export function registerWebhookConfig(config: WebhookConfig): void {
  webhookConfigs.set(config.sessionId, config);
  console.log(`[WEBHOOK CLIENT] Registered webhook for session ${JSON.stringify(config.sessionId)}`);
}

/**
 * Remove webhook configuration for a session.
 */
export function unregisterWebhookConfig(sessionId: string): void {
  webhookConfigs.delete(sessionId);
  console.log(`[WEBHOOK CLIENT] Unregistered webhook for session ${sessionId}`);
}

/**
 * Get webhook config for a session.
 */
export function getWebhookConfig(sessionId: string): WebhookConfig | undefined {
  return webhookConfigs.get(sessionId);
}

/**
 * Generate HMAC-SHA256 signature for payload.
 */
function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Webhook retry configuration */
export const webhookRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
};

/**
 * Send webhook request to backend with retry for transient failures.
 * Non-blocking - doesn't throw on failure, just logs.
 */
async function sendWebhook<T extends object>(
  endpoint: string,
  payload: T,
  config: WebhookConfig
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, config.webhookSecret);
  const { maxRetries, baseDelayMs } = webhookRetryConfig;

  // Use trusted base URL from environment configuration (not user input)
  // This prevents SSRF by ensuring the fetch target is server-controlled
  const url = `${TRUSTED_WEBHOOK_BASE_URL}/${endpoint}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body,
      });

      if (response.ok) {
        return true;
      }

      // Retry on 429 (rate limited) or 5xx (server error)
      const isRetryable = response.status === 429 || response.status >= 500;
      if (isRetryable && attempt < maxRetries) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelayMs * Math.pow(2, attempt);
        console.warn(`[WEBHOOK CLIENT] ${endpoint} got ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error or exhausted retries
      const errorData = await response.json().catch(() => ({}));
      console.error(`[WEBHOOK CLIENT] ${endpoint} failed: ${response.status} ${(errorData as any).message || ''}`);
      return false;
    } catch (error: any) {
      // Network errors are retryable
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[WEBHOOK CLIENT] ${endpoint} network error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      console.error(`[WEBHOOK CLIENT] ${endpoint} error after ${maxRetries} retries:`, error.message);
      return false;
    }
  }

  return false;
}

/**
 * Notify backend that an item has completed processing.
 * Called from ScrapeQueue.handleSuccess and handleFailure.
 */
export async function notifyItemComplete(payload: ItemCompletePayload): Promise<boolean> {
  const config = webhookConfigs.get(payload.sessionId);
  if (!config) {
    // No webhook registered for this session - might be a single item scrape
    return false;
  }

  return sendWebhook('item-complete', payload, config);
}

/**
 * Notify backend of a sync phase change.
 * Called from syncOrchestrator during sync lifecycle.
 */
export async function notifyPhaseChange(payload: PhaseChangePayload): Promise<boolean> {
  const config = webhookConfigs.get(payload.sessionId);
  if (!config) {
    console.warn(`[WEBHOOK CLIENT] No webhook config for session ${JSON.stringify(payload.sessionId)}`);
    return false;
  }

  return sendWebhook('phase-change', payload, config);
}

/**
 * Convenience function to notify item completed successfully.
 */
export async function notifyItemSuccess(
  sessionId: string,
  mfcId: string,
  scrapedData?: Record<string, unknown>
): Promise<boolean> {
  return notifyItemComplete({
    sessionId,
    mfcId,
    status: 'completed',
    scrapedData,
  });
}

/**
 * Convenience function to notify item failed.
 */
export async function notifyItemFailed(
  sessionId: string,
  mfcId: string,
  error: string
): Promise<boolean> {
  return notifyItemComplete({
    sessionId,
    mfcId,
    status: 'failed',
    error,
  });
}

/**
 * Convenience function to notify item skipped.
 */
export async function notifyItemSkipped(
  sessionId: string,
  mfcId: string
): Promise<boolean> {
  return notifyItemComplete({
    sessionId,
    mfcId,
    status: 'skipped',
  });
}
