/**
 * Type-test fixture: the ruleset-declared gone page (contract 0.13.0) — `ExtractionRuleset.gonePage`.
 * RED before the bump (excess-property error); GREEN after. `existing-two-arg-ruleset.ts` remains
 * the guard that a ruleset declaring nothing still compiles.
 */
import type { ExtractionRuleset, GonePage } from '../src/index';

/** A store that answers a removed item with HTTP 500 and its own error-page title. */
const gonePage: GonePage = { statuses: [500], titleIncludes: 'Error Page | EXAMPLE STORE' };

export const rulesetWithGonePage: ExtractionRuleset = {
  siteId: 'examplestore',
  version: '1.0.0',
  extract: (_html, url) => ({
    source: { site: 'examplestore', itemId: '1', url, extractedAt: '2026-09-22T00:00:00.000Z', rulesetVersion: '1.0.0' },
    fields: {},
    warnings: [],
  }),
  validate: () => ({ valid: true, errors: [], warnings: [] }),
  gonePage,
};

// @ts-expect-error — `statuses` is a list, never a bare status
export const badStatuses: GonePage = { statuses: 500, titleIncludes: 'x' };
