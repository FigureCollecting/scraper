/**
 * Security utilities for input sanitization and validation
 *
 * Addresses CodeQL alerts:
 * - Log injection: sanitizeForLog() prevents newlines and special chars
 * - Resource exhaustion: MAX_WAIT_TIME caps user-controlled timeouts
 * - Loop bound injection: MAX_STRING_LENGTH caps string processing
 */

// Maximum wait time in milliseconds (30 seconds)
export const MAX_WAIT_TIME = 30000;

// Maximum string length for edit distance calculations (prevents O(n²) DoS)
export const MAX_STRING_LENGTH = 1000;

/**
 * Sanitizes user input for safe logging.
 * Prevents log injection attacks by removing/escaping:
 * - Newlines (could forge log entries)
 * - Carriage returns
 * - ANSI escape sequences (could manipulate terminal output)
 * - Control characters
 *
 * @param input - User-controlled input to sanitize
 * @returns Sanitized string safe for logging
 */
export function sanitizeForLog(input: string): string {
  if (typeof input !== 'string') {
    return String(input);
  }

  return input
    // Remove newlines and carriage returns (log entry forgery)
    .replace(/[\r\n]/g, ' ')
    // Remove ANSI escape sequences (terminal manipulation)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // Remove other control characters
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Truncate extremely long inputs
    .substring(0, 2000);
}

/**
 * Caps a wait time value to prevent resource exhaustion.
 *
 * @param waitTime - User-provided wait time
 * @param defaultTime - Default if not provided (default: 1000ms)
 * @returns Capped wait time
 */
export function capWaitTime(waitTime: number | undefined, defaultTime: number = 1000): number {
  const time = waitTime ?? defaultTime;

  // Ensure non-negative and cap at maximum
  if (time < 0) return defaultTime;
  return Math.min(time, MAX_WAIT_TIME);
}

/**
 * Truncates strings to prevent O(n²) complexity in string operations.
 *
 * @param str - Input string
 * @param maxLength - Maximum length (default: MAX_STRING_LENGTH)
 * @returns Truncated string
 */
export function truncateString(str: string, maxLength: number = MAX_STRING_LENGTH): string {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLength);
}

/**
 * Validates that a URL is safe for webhook requests.
 * Prevents SSRF attacks by blocking:
 * - Non-HTTP(S) schemes (e.g., file://, ftp://)
 * - Private/internal IP addresses (localhost, 127.0.0.1, 10.x, 192.168.x, 172.16-31.x)
 * - IPv6 loopback (::1)
 *
 * @param url - URL to validate
 * @returns true if URL is safe for webhook requests
 */
export function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http/https schemes
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    // Block private/internal IPs in production
    const hostname = parsed.hostname.toLowerCase();
    if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') {
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
      if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.match(/^172\.(1[6-9]|2\d|3[01])\./)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes an object for safe logging by converting it to JSON
 * and sanitizing the resulting string.
 *
 * @param obj - Object to sanitize
 * @param maxLength - Maximum output length (default: 500)
 * @returns Sanitized JSON string safe for logging
 */
export function sanitizeObjectForLog(obj: unknown, maxLength: number = 500): string {
  try {
    const json = JSON.stringify(obj, null, 2);
    return sanitizeForLog(json).substring(0, maxLength);
  } catch {
    return '[Unable to serialize object]';
  }
}
