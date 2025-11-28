/**
 * Unit tests for security utilities
 *
 * Tests CodeQL security mitigations:
 * - Log injection prevention
 * - URL sanitization
 * - Resource exhaustion prevention
 * - Loop bound injection prevention
 */

import {
  sanitizeForLog,
  sanitizeObjectForLog,
  isValidMfcUrl,
  capWaitTime,
  truncateString,
  MAX_WAIT_TIME,
  MAX_STRING_LENGTH
} from '../../utils/security';

describe('Security Utilities', () => {
  describe('sanitizeForLog', () => {
    it('should remove newlines from input', () => {
      const malicious = 'normal text\n[FAKE LOG] Admin logged in\nmore text';
      const sanitized = sanitizeForLog(malicious);

      expect(sanitized).not.toContain('\n');
      expect(sanitized).toBe('normal text [FAKE LOG] Admin logged in more text');
    });

    it('should remove carriage returns', () => {
      const malicious = 'text\rmore\r\ntext';
      const sanitized = sanitizeForLog(malicious);

      expect(sanitized).not.toContain('\r');
      expect(sanitized).not.toContain('\n');
    });

    it('should remove ANSI escape sequences', () => {
      const malicious = 'text\x1b[31mRED TEXT\x1b[0m more';
      const sanitized = sanitizeForLog(malicious);

      expect(sanitized).not.toContain('\x1b');
      expect(sanitized).toBe('textRED TEXT more');
    });

    it('should remove control characters', () => {
      const malicious = 'text\x00\x07\x08more';
      const sanitized = sanitizeForLog(malicious);

      expect(sanitized).toBe('textmore');
    });

    it('should truncate extremely long inputs', () => {
      const longInput = 'a'.repeat(3000);
      const sanitized = sanitizeForLog(longInput);

      expect(sanitized.length).toBe(2000);
    });

    it('should handle non-string inputs gracefully', () => {
      expect(sanitizeForLog(123 as any)).toBe('123');
      expect(sanitizeForLog(null as any)).toBe('null');
      expect(sanitizeForLog(undefined as any)).toBe('undefined');
    });

    it('should preserve normal URLs', () => {
      const url = 'https://myfigurecollection.net/item/123456';
      expect(sanitizeForLog(url)).toBe(url);
    });
  });

  describe('sanitizeObjectForLog', () => {
    it('should convert objects to sanitized JSON strings', () => {
      const obj = { name: 'Test', value: 123 };
      const result = sanitizeObjectForLog(obj);

      expect(result).toContain('Test');
      expect(result).toContain('123');
    });

    it('should sanitize newlines in object values', () => {
      const obj = { malicious: 'line1\nline2\nline3' };
      const result = sanitizeObjectForLog(obj);

      expect(result).not.toContain('\n');
    });

    it('should sanitize ANSI escape sequences in object values', () => {
      const obj = { colored: '\x1b[31mRed\x1b[0m' };
      const result = sanitizeObjectForLog(obj);

      expect(result).not.toContain('\x1b');
    });

    it('should truncate large objects', () => {
      const largeObj = { data: 'x'.repeat(1000) };
      const result = sanitizeObjectForLog(largeObj, 100);

      expect(result.length).toBeLessThanOrEqual(100);
    });

    it('should handle non-serializable objects gracefully', () => {
      const circular: any = { name: 'test' };
      circular.self = circular;

      const result = sanitizeObjectForLog(circular);
      expect(result).toBe('[Unable to serialize object]');
    });

    it('should handle null and undefined', () => {
      expect(sanitizeObjectForLog(null)).toBe('null');
      expect(sanitizeObjectForLog(undefined)).toBe('undefined');
    });

    it('should handle arrays', () => {
      const arr = [1, 2, 'test'];
      const result = sanitizeObjectForLog(arr);

      expect(result).toContain('1');
      expect(result).toContain('test');
      // Pretty-printed JSON newlines are replaced with spaces
      expect(result).not.toContain('\n');
    });

    it('should remove newlines from pretty-printed JSON output', () => {
      const obj = { key: 'value', nested: { deep: true } };
      const result = sanitizeObjectForLog(obj);

      // JSON.stringify with indent would normally have newlines
      // Our sanitizer removes them
      expect(result).not.toContain('\n');
    });
  });

  describe('isValidMfcUrl', () => {
    it('should accept valid myfigurecollection.net URLs', () => {
      expect(isValidMfcUrl('https://myfigurecollection.net/item/123')).toBe(true);
      expect(isValidMfcUrl('http://myfigurecollection.net/item/123')).toBe(true);
      expect(isValidMfcUrl('https://www.myfigurecollection.net/item/123')).toBe(true);
    });

    it('should accept valid subdomains', () => {
      expect(isValidMfcUrl('https://static.myfigurecollection.net/image.jpg')).toBe(true);
      expect(isValidMfcUrl('https://api.myfigurecollection.net/v1/items')).toBe(true);
    });

    it('should reject URLs with myfigurecollection.net in subdomain of attacker domain', () => {
      // This is the key security test - prevents bypass attacks
      expect(isValidMfcUrl('https://myfigurecollection.net.evil.com/item/123')).toBe(false);
    });

    it('should reject URLs with myfigurecollection.net in path', () => {
      expect(isValidMfcUrl('https://evil.com/myfigurecollection.net/item/123')).toBe(false);
    });

    it('should reject non-MFC domains', () => {
      expect(isValidMfcUrl('https://google.com')).toBe(false);
      expect(isValidMfcUrl('https://example.com')).toBe(false);
    });

    it('should reject invalid URLs', () => {
      expect(isValidMfcUrl('not-a-url')).toBe(false);
      expect(isValidMfcUrl('')).toBe(false);
    });

    it('should handle malformed URLs gracefully', () => {
      expect(isValidMfcUrl('://missing-protocol')).toBe(false);
      expect(isValidMfcUrl('https://')).toBe(false);
    });
  });

  describe('capWaitTime', () => {
    it('should return default for undefined input', () => {
      expect(capWaitTime(undefined)).toBe(1000);
      expect(capWaitTime(undefined, 2000)).toBe(2000);
    });

    it('should cap extremely large values', () => {
      expect(capWaitTime(999999999)).toBe(MAX_WAIT_TIME);
      expect(capWaitTime(Number.MAX_SAFE_INTEGER)).toBe(MAX_WAIT_TIME);
    });

    it('should return default for negative values', () => {
      expect(capWaitTime(-1000)).toBe(1000);
      expect(capWaitTime(-1, 500)).toBe(500);
    });

    it('should allow reasonable values through', () => {
      expect(capWaitTime(5000)).toBe(5000);
      expect(capWaitTime(100)).toBe(100);
    });

    it('should cap at MAX_WAIT_TIME', () => {
      expect(capWaitTime(MAX_WAIT_TIME + 1)).toBe(MAX_WAIT_TIME);
      expect(capWaitTime(MAX_WAIT_TIME)).toBe(MAX_WAIT_TIME);
    });
  });

  describe('truncateString', () => {
    it('should truncate strings exceeding max length', () => {
      const longString = 'a'.repeat(2000);
      const truncated = truncateString(longString);

      expect(truncated.length).toBe(MAX_STRING_LENGTH);
    });

    it('should preserve strings under max length', () => {
      const shortString = 'hello world';
      expect(truncateString(shortString)).toBe(shortString);
    });

    it('should allow custom max length', () => {
      const input = 'hello world';
      expect(truncateString(input, 5)).toBe('hello');
    });

    it('should handle empty strings', () => {
      expect(truncateString('')).toBe('');
    });

    it('should handle non-string inputs', () => {
      expect(truncateString(123 as any)).toBe('');
      expect(truncateString(null as any)).toBe('');
    });
  });

  describe('Constants', () => {
    it('should have reasonable MAX_WAIT_TIME', () => {
      // Should be at least 1 second
      expect(MAX_WAIT_TIME).toBeGreaterThanOrEqual(1000);
      // Should not exceed 1 minute (reasonable upper bound)
      expect(MAX_WAIT_TIME).toBeLessThanOrEqual(60000);
    });

    it('should have reasonable MAX_STRING_LENGTH', () => {
      // Should be at least 100 chars
      expect(MAX_STRING_LENGTH).toBeGreaterThanOrEqual(100);
      // Should not be excessively large
      expect(MAX_STRING_LENGTH).toBeLessThanOrEqual(10000);
    });
  });
});
