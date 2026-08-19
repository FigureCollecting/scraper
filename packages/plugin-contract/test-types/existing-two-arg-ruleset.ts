/**
 * Type-test fixture: a plain, pre-existing 2-argument ruleset (extract + validate only,
 * no extractMany) must keep compiling unchanged against ExtractionRuleset — this is the
 * backward-compatibility guarantee for the 0.4.0 additive bump (orzgk Slice B, spec.md D9).
 * This file must NEVER go red; it is the regression guard for every other fixture in this
 * directory that intentionally starts red.
 */
import type { ExtractionRuleset, ExtractedData, ValidationResult } from '../src/index';

const ruleset: ExtractionRuleset = {
  siteId: 'example',
  version: '1.0',
  extract(html: string, url: string): ExtractedData {
    return {
      source: { site: 'example', itemId: '1', extractedAt: new Date().toISOString() },
      fields: { html, url },
      warnings: [],
    };
  },
  validate(_data: ExtractedData): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  },
};

void ruleset;
