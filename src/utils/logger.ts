/**
 * Production-safe debug logging utility for Page Scraper Service
 *
 * Enable debug logging by setting environment variables:
 * - DEBUG=* (all debug logs)
 * - DEBUG=scraper:* (all scraper logs)
 * - DEBUG=scraper:mfc (MFC scraping logs)
 * - DEBUG=scraper:browser (browser/puppeteer logs)
 * - DEBUG=scraper:registration (service registration logs)
 * - SERVICE_AUTH_TOKEN_DEBUG=true (show partial token for debugging, NEVER full token)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTraceContext, redactValue } from '@figurecollecting/fc-shared';

export interface Logger {
  debug: (namespace: string, message: string, data?: any) => void;
  info: (message: string, data?: any) => void;
  warn: (message: string, data?: any) => void;
  error: (message: string, error?: any) => void;
}

class DebugLogger implements Logger {
  private enabledNamespaces: Set<string>;
  private tokenDebug: boolean;

  constructor() {
    this.enabledNamespaces = this.parseDebugEnv();
    this.tokenDebug = process.env.SERVICE_AUTH_TOKEN_DEBUG === 'true';
  }

  private parseDebugEnv(): Set<string> {
    const debugEnv = process.env.DEBUG || '';
    if (!debugEnv) return new Set();

    if (debugEnv === '*') {
      return new Set(['*']);
    }

    return new Set(
      debugEnv.split(',')
        .map(ns => ns.trim())
        .filter(ns => ns.length > 0)
    );
  }

  private isNamespaceEnabled(namespace: string): boolean {
    if (this.enabledNamespaces.has('*')) return true;
    if (this.enabledNamespaces.has(namespace)) return true;

    // Check for wildcard patterns like scraper:*
    for (const pattern of this.enabledNamespaces) {
      if (pattern.endsWith(':*')) {
        const prefix = pattern.slice(0, -1); // Remove the *
        if (namespace.startsWith(prefix)) return true;
      }
    }

    return false;
  }

  private sanitizeData(data: any): any {
    if (!data) return data;

    // Create a deep copy to avoid modifying the original
    const sanitized = JSON.parse(JSON.stringify(data));

    // Sanitize sensitive fields
    const sensitiveFields = ['token', 'password', 'secret', 'key', 'authorization'];

    const sanitizeObject = (obj: any) => {
      for (const key in obj) {
        const lowerKey = key.toLowerCase();

        if (sensitiveFields.some(field => lowerKey.includes(field))) {
          if (typeof obj[key] === 'string' && obj[key].length > 0) {
            // For tokens, show partial if debug enabled
            if (lowerKey.includes('token') && this.tokenDebug) {
              obj[key] = obj[key].substring(0, 8) + '...' + obj[key].slice(-4);
            } else {
              obj[key] = '[REDACTED]';
            }
          }
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitizeObject(obj[key]);
        }
      }
    };

    if (typeof sanitized === 'object' && sanitized !== null) {
      sanitizeObject(sanitized);
    }

    return sanitized;
  }

  /**
   * ` trace=<traceId> span=<spanId>` when an OpenTelemetry span is active, or ''
   * otherwise (outside a request, or tracing disabled — e.g. tests). Threads a
   * backend→scraper request's traceId through every log line for end-to-end
   * correlation. Sourced from fc-shared so the tag format is identical across
   * services. Safe no-op until a tracing backend is attached.
   */
  private traceTag(): string {
    const tc = getTraceContext();
    return tc ? ` ${tc}` : '';
  }

  debug(namespace: string, message: string, data?: any): void {
    if (!this.isNamespaceEnabled(namespace)) return;

    const timestamp = new Date().toISOString();
    const sanitizedData = redactValue(this.sanitizeData(data));

    console.log(`[${timestamp}] [DEBUG] [${namespace}]${this.traceTag()} ${message}`,
      sanitizedData ? JSON.stringify(sanitizedData, null, 2) : '');
  }

  info(message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const sanitizedData = redactValue(this.sanitizeData(data));

    console.log(`[${timestamp}] [INFO]${this.traceTag()} ${message}`,
      sanitizedData ? JSON.stringify(sanitizedData, null, 2) : '');
  }

  warn(message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const sanitizedData = redactValue(this.sanitizeData(data));

    console.warn(`[${timestamp}] [WARN]${this.traceTag()} ${message}`,
      sanitizedData ? JSON.stringify(sanitizedData, null, 2) : '');
  }

  error(message: string, error?: any): void {
    const timestamp = new Date().toISOString();

    // Handle Error objects specially
    let errorData: any;
    if (error instanceof Error) {
      errorData = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
    } else {
      errorData = redactValue(this.sanitizeData(error));
    }

    console.error(`[${timestamp}] [ERROR]${this.traceTag()} ${message}`,
      errorData ? JSON.stringify(errorData, null, 2) : '');
  }
}

// Export singleton instance
export const logger = new DebugLogger();

// Export debug helpers for specific namespaces
export const scraperDebug = {
  mfc: (message: string, data?: any) => logger.debug('scraper:mfc', message, data),
  browser: (message: string, data?: any) => logger.debug('scraper:browser', message, data),
  registration: (message: string, data?: any) => logger.debug('scraper:registration', message, data),
  api: (message: string, data?: any) => logger.debug('scraper:api', message, data),
  pool: (message: string, data?: any) => logger.debug('scraper:pool', message, data),
  enrichment: (message: string, data?: any) => logger.debug('scraper:enrichment', message, data),
};

/**
 * Enrichment tracking logger for sync analysis.
 * These logs are always written (not debug-gated) for later analysis.
 * Use structured JSON format for easy parsing.
 *
 * Logs are written to:
 * - Console (stdout) for real-time viewing
 * - File (logs/enrichment.log) for later analysis
 *
 * View logs: cat logs/enrichment.log | grep "FAILURE"
 */
export interface EnrichmentEvent {
  event: 'start' | 'success' | 'failure' | 'retry' | 'skip' | 'rate_limited';
  mfcId: string;
  sessionId?: string;
  status?: 'owned' | 'ordered' | 'wished';
  errorType?: string;
  httpStatus?: number;
  retryCount?: number;
  maxRetries?: number;
  durationMs?: number;
  reason?: string;
  // Field completeness tracking for partial re-enrichment analysis
  fields?: {
    imageUrl?: boolean;
    name?: boolean;
    manufacturer?: boolean;
    origin?: boolean;
    releaseDate?: boolean;
    price?: boolean;
  };
}

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const enrichmentLogPath = path.join(logsDir, 'enrichment.log');

export const enrichmentLogger = {
  /**
   * Log an enrichment event in structured format for later analysis
   * Writes to both console AND file for persistence
   */
  log(event: EnrichmentEvent): void {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      component: 'ENRICHMENT',
      ...event,
    };
    const logLine = `[${timestamp}] [ENRICHMENT] ${event.event.toUpperCase()} mfcId=${event.mfcId} ${JSON.stringify(entry)}`;

    // Console output
    console.log(logLine);

    // File output (append)
    fs.appendFileSync(enrichmentLogPath, logLine + '\n');
  },

  /**
   * Log successful enrichment with field completeness for analysis
   */
  success(mfcId: string, sessionId?: string, durationMs?: number, fields?: {
    imageUrl?: boolean;
    name?: boolean;
    manufacturer?: boolean;
    origin?: boolean;
    releaseDate?: boolean;
    price?: boolean;
  }): void {
    this.log({ event: 'success', mfcId, sessionId, durationMs, fields });
  },

  /**
   * Log failed enrichment with error details
   */
  failure(mfcId: string, errorType: string, reason: string, opts?: {
    sessionId?: string;
    httpStatus?: number;
    retryCount?: number;
    maxRetries?: number;
    durationMs?: number;
  }): void {
    this.log({
      event: 'failure',
      mfcId,
      errorType,
      reason,
      ...opts,
    });
  },

  /**
   * Log rate limit event (MFC busy)
   */
  rateLimited(mfcId: string, sessionId?: string, isCloudflare?: boolean): void {
    this.log({
      event: 'rate_limited',
      mfcId,
      sessionId,
      reason: isCloudflare ? 'Cloudflare block' : 'MFC rate limit (429/503)',
    });
  },

  /**
   * Log retry attempt
   */
  retry(mfcId: string, retryCount: number, maxRetries: number, sessionId?: string): void {
    this.log({ event: 'retry', mfcId, retryCount, maxRetries, sessionId });
  },

  /**
   * Log skipped item (already exists, duplicate, etc.)
   */
  skip(mfcId: string, reason: string, sessionId?: string): void {
    this.log({ event: 'skip', mfcId, reason, sessionId });
  },
};