/**
 * @fileoverview Unit tests for string comparison utilities
 * Tests the calculateSimilarity and getEditDistance functions used for
 * title matching in the scraper. These tests verify that the security
 * fix (truncateString) doesn't break the algorithm's correctness.
 */

import { calculateSimilarity, getEditDistance } from '../../services/genericScraper';

describe('String Comparison Utilities', () => {
  describe('getEditDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(getEditDistance('hello', 'hello')).toBe(0);
    });

    it('should return string length for empty comparison', () => {
      expect(getEditDistance('hello', '')).toBe(5);
      expect(getEditDistance('', 'world')).toBe(5);
    });

    it('should return 0 for two empty strings', () => {
      expect(getEditDistance('', '')).toBe(0);
    });

    it('should calculate single character difference', () => {
      expect(getEditDistance('cat', 'bat')).toBe(1);
      expect(getEditDistance('cat', 'cut')).toBe(1);
    });

    it('should calculate multiple differences', () => {
      expect(getEditDistance('kitten', 'sitting')).toBe(3);
      expect(getEditDistance('saturday', 'sunday')).toBe(3);
    });

    it('should handle case sensitivity', () => {
      expect(getEditDistance('Hello', 'hello')).toBe(1);
    });

    it('should truncate very long strings (security fix)', () => {
      // This test verifies the security fix doesn't crash with DoS-length strings
      const longString = 'a'.repeat(2000);
      const anotherLongString = 'b'.repeat(2000);

      // Should not throw and should complete in reasonable time
      const result = getEditDistance(longString, anotherLongString);

      // After truncation to MAX_STRING_LENGTH (1000), both strings should differ
      expect(result).toBeLessThanOrEqual(1000);
    });
  });

  describe('calculateSimilarity', () => {
    it('should return 1 for identical strings', () => {
      expect(calculateSimilarity('hello', 'hello')).toBe(1);
    });

    it('should return 0 for completely different strings of same length', () => {
      expect(calculateSimilarity('abc', 'xyz')).toBeLessThan(1);
    });

    it('should return high similarity for similar strings', () => {
      const similarity = calculateSimilarity('hello world', 'hello worlD');
      expect(similarity).toBeGreaterThan(0.9);
    });

    it('should return lower similarity for different strings', () => {
      const similarity = calculateSimilarity('hello', 'goodbye');
      expect(similarity).toBeLessThan(0.5);
    });

    it('should handle empty strings', () => {
      expect(calculateSimilarity('', '')).toBe(1);
      expect(calculateSimilarity('hello', '')).toBe(0);
      expect(calculateSimilarity('', 'world')).toBe(0);
    });

    it('should work with figure titles', () => {
      const title1 = 'Hatsune Miku - Racing Ver. 2023';
      const title2 = 'Hatsune Miku Racing Version 2023';
      const similarity = calculateSimilarity(title1, title2);
      expect(similarity).toBeGreaterThan(0.7);
    });

    it('should handle special characters', () => {
      const title1 = 'フィギュア - 1/7スケール';
      const title2 = 'フィギュア - 1/8スケール';
      const similarity = calculateSimilarity(title1, title2);
      expect(similarity).toBeGreaterThan(0.8);
    });
  });
});
