/**
 * Type-test fixture: a ruleset implementing the OPTIONAL extractMany() member (added for
 * orzgk Slice B multi-record extract, spec.md §3.1/§6 B1). RED before the 0.4.0 bump
 * (extractMany does not exist on ExtractionRuleset ⇒ excess-property error on the object
 * literal); GREEN after.
 */
import type { ExtractionRuleset, ExtractedData, ValidationResult, ExtractContext } from '../src/index';

const ruleset: ExtractionRuleset = {
  siteId: 'orzgk',
  version: '1.1',
  extract(html: string, url: string): ExtractedData {
    return {
      source: { site: 'orzgk', itemId: 'parent', extractedAt: new Date().toISOString() },
      fields: { html, url },
      warnings: [],
    };
  },
  validate(_data: ExtractedData): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  },
  async extractMany(html: string, url: string, ctx?: ExtractContext): Promise<ExtractedData[]> {
    void ctx;
    return [
      {
        source: { site: 'orzgk', itemId: 'parent', extractedAt: new Date().toISOString() },
        fields: { html, url },
        warnings: [],
      },
      {
        source: { site: 'orzgk', itemId: 'child-1', extractedAt: new Date().toISOString() },
        fields: { editionOf: 'parent' },
        warnings: [],
      },
    ];
  },
};

void ruleset;
