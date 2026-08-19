/**
 * extractRecords — dispatch precedence (extractMany > extractAsync > extract), always-array
 * wrapping, and the D11 multi-record guards (empty / duplicate itemId / target-before-source).
 */
import type { ExtractContext, ExtractedData, ExtractionRuleset } from '@figurecollecting/scraper-plugin-contract';
import { extractRecords } from '../extractRecords';

const HTML = '<html>ok</html>';
const URL = 'https://example.test/item/1';

function baseRuleset(overrides: Partial<ExtractionRuleset> = {}): ExtractionRuleset {
  return {
    siteId: 'mock-site',
    version: '1.0.0',
    extract: jest.fn(),
    validate: jest.fn(() => ({ valid: true, errors: [], warnings: [] })),
    ...overrides,
  };
}

function record(itemId: string, fields: Record<string, unknown> = {}): ExtractedData {
  return {
    source: { site: 'mock-site', itemId, url: URL, extractedAt: '2026-08-19T00:00:00.000Z' },
    fields,
    warnings: [],
  };
}

describe('extractRecords — dispatch precedence', () => {
  it('calls extractMany when present, ignoring extract/extractAsync, and returns its array verbatim', async () => {
    const many = jest.fn().mockResolvedValue([record('P'), record('C', { editionOf: 'P' })]);
    const extract = jest.fn();
    const extractAsync = jest.fn();
    const ruleset = baseRuleset({ extract, extractMany: many }) as ExtractionRuleset & {
      extractAsync: jest.Mock;
    };
    ruleset.extractAsync = extractAsync;

    const ctx = { config: {}, scraping: {}, logger: {} } as unknown as ExtractContext;
    const result = await extractRecords(ruleset, HTML, URL, ctx);

    expect(many).toHaveBeenCalledWith(HTML, URL, ctx);
    expect(extract).not.toHaveBeenCalled();
    expect(extractAsync).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0].source.itemId).toBe('P');
    expect(result[1].source.itemId).toBe('C');
  });

  it('falls back to extractAsync (wrapped in a 1-element array) when extractMany is absent', async () => {
    const extractAsync = jest.fn().mockResolvedValue(record('A'));
    const extract = jest.fn();
    const ruleset = baseRuleset({ extract }) as ExtractionRuleset & { extractAsync: jest.Mock };
    ruleset.extractAsync = extractAsync;

    const result = await extractRecords(ruleset, HTML, URL, undefined);

    expect(extractAsync).toHaveBeenCalledWith(HTML, URL, undefined);
    expect(extract).not.toHaveBeenCalled();
    expect(result).toEqual([record('A')]);
  });

  it('falls back to extract (wrapped in a 1-element array) when neither extractMany nor extractAsync is present — byte-for-byte today\'s single-record path', async () => {
    const extract = jest.fn().mockResolvedValue(record('SOLO'));
    const ruleset = baseRuleset({ extract });
    const ctx = { config: {}, scraping: {}, logger: {} } as unknown as ExtractContext;

    const result = await extractRecords(ruleset, HTML, URL, ctx);

    expect(extract).toHaveBeenCalledWith(HTML, URL, ctx);
    expect(result).toEqual([record('SOLO')]);
  });

  it('awaits a synchronous extract() return value transparently (E1)', async () => {
    const extract = jest.fn().mockReturnValue(record('SYNC'));
    const ruleset = baseRuleset({ extract });

    const result = await extractRecords(ruleset, HTML, URL, undefined);

    expect(result).toEqual([record('SYNC')]);
  });
});

describe('extractRecords — D11 guards', () => {
  it('throws when extractMany returns an empty array (nothing emitted)', async () => {
    const ruleset = baseRuleset({ extractMany: jest.fn().mockResolvedValue([]) });

    await expect(extractRecords(ruleset, HTML, URL, undefined)).rejects.toThrow(/empty/i);
  });

  it('throws on a duplicate source.itemId across records', async () => {
    const ruleset = baseRuleset({
      extractMany: jest.fn().mockResolvedValue([record('X'), record('X')]),
    });

    await expect(extractRecords(ruleset, HTML, URL, undefined)).rejects.toThrow(/duplicate/i);
  });

  it('throws when a child (editionOf) precedes its target (child-before-target)', async () => {
    const ruleset = baseRuleset({
      extractMany: jest.fn().mockResolvedValue([record('C', { editionOf: 'P' }), record('P')]),
    });

    await expect(extractRecords(ruleset, HTML, URL, undefined)).rejects.toThrow(/target-first|before/i);
  });

  it('throws when a record (offerOf) names a target itemId that never appears at all', async () => {
    const ruleset = baseRuleset({
      extractMany: jest.fn().mockResolvedValue([record('P'), record('T', { offerOf: 'GHOST' })]),
    });

    await expect(extractRecords(ruleset, HTML, URL, undefined)).rejects.toThrow(/target-first|before/i);
  });

  it('throws when a record targets itself via editionOf', async () => {
    const ruleset = baseRuleset({
      extractMany: jest.fn().mockResolvedValue([record('P'), record('SELF', { editionOf: 'SELF' })]),
    });

    await expect(extractRecords(ruleset, HTML, URL, undefined)).rejects.toThrow(/itself/i);
  });

  it('accepts a valid target-first array with editionOf AND a separate offerOf chain', async () => {
    const ruleset = baseRuleset({
      extractMany: jest.fn().mockResolvedValue([
        record('P'),
        record('E1', { editionOf: 'P' }),
        record('T1', { offerOf: 'E1' }),
      ]),
    });

    const result = await extractRecords(ruleset, HTML, URL, undefined);
    expect(result.map((r) => r.source.itemId)).toEqual(['P', 'E1', 'T1']);
  });

  it('never calls ruleset.validate() — mirrors today\'s path, which does not validate either', async () => {
    const validate = jest.fn(() => ({ valid: true, errors: [], warnings: [] }));
    const ruleset = baseRuleset({
      validate,
      extractMany: jest.fn().mockResolvedValue([record('P')]),
    });

    await extractRecords(ruleset, HTML, URL, undefined);
    expect(validate).not.toHaveBeenCalled();
  });

  it('treats a record with no fields object as carrying no target (never throws reading it)', async () => {
    const bare = { source: { site: 'mock-site', itemId: 'BARE', url: URL, extractedAt: 't' } } as unknown as ExtractedData;
    const ruleset = baseRuleset({ extractMany: jest.fn().mockResolvedValue([bare]) });

    const result = await extractRecords(ruleset, HTML, URL, undefined);
    expect(result).toEqual([bare]);
  });

  it('throws when a record has no source.itemId', async () => {
    const bad = { source: { site: 'mock-site', itemId: '', url: URL, extractedAt: 't' }, fields: {}, warnings: [] };
    const ruleset = baseRuleset({ extractMany: jest.fn().mockResolvedValue([bad]) });

    await expect(extractRecords(ruleset, HTML, URL, undefined)).rejects.toThrow(/itemId/i);
  });
});
