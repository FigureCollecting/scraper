/**
 * Security utilities for input sanitization and validation
 *
 * Addresses CodeQL alerts:
 * - Log injection: sanitizeForLog() prevents newlines and special chars
 * - Incomplete URL sanitization: isValidMfcUrl() uses proper URL parsing
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
 * Validates that a URL is a legitimate myfigurecollection.net URL.
 * Uses proper URL parsing to prevent bypass attacks like:
 * - myfigurecollection.net.evil.com (subdomain attack)
 * - evil.com/myfigurecollection.net (path attack)
 *
 * @param url - URL to validate
 * @returns true if URL is from myfigurecollection.net domain
 */
export function isValidMfcUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    // Must be exactly myfigurecollection.net or a valid subdomain
    return hostname === 'myfigurecollection.net' ||
           hostname.endsWith('.myfigurecollection.net');
  } catch {
    return false;
  }
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
