/**
 * Schema v3 Company/Artist/Field Extraction from MFC HTML
 *
 * Extracts company and artist data with roles from MFC figure pages.
 * Companies: Manufacturer, Distributor, Retailer
 * Artists: Sculptor, Illustrator, Painter, Designer
 *
 * Also extracts individual MFC fields:
 * - Title (figure name)
 * - Origin (series/franchise)
 * - Version (variant info)
 * - Category, Classification
 * - Materials, Dimensions
 *
 * Uses mfcLabelRegistry for resilient label matching (regex-based,
 * case-insensitive, singular/plural tolerant).
 */

import * as cheerio from 'cheerio';
import { lookupLabel, normalizeRole, type ExtractionStrategy } from './mfcLabelRegistry';

/**
 * MFC field data extracted from the page
 */
export interface IMfcFieldData {
  title?: string;         // The figure's specific title/name
  origin?: string;        // Series/franchise (e.g., "Original", "Fate/Grand Order")
  version?: string;       // Variant info (e.g., "Little Devil Ver.")
  category?: string;      // e.g., "Scale Figure"
  classification?: string; // e.g., "Goods"
  materials?: string;     // e.g., "PVC, ABS"
  dimensions?: string;    // e.g., "H=250mm"
  jan?: string;           // JAN/UPC barcode
  tags?: string[];        // Various tags (e.g., "18+", "Castoff", "Limited")
  communityOwnedCount?: number;
  communityOrderedCount?: number;
  communityWishedCount?: number;
  communityListedCount?: number;
  communityScore?: number;        // Average public score (1-10, may be decimal like 8.5)
  unknownFields?: string[]; // Labels not recognized by registry
}

export interface ICompanyEntry {
  name: string;
  role: string;  // "Manufacturer", "Distributor", etc.
  mfcId?: number;
}

export interface IArtistEntry {
  name: string;
  role: string;  // "Sculptor", "Illustrator", "Painter", "Designer"
  mfcId?: number;
}

/**
 * Extract MFC ID from href attribute
 * Handles formats like "/entry/company/123" or "/entry/artist/456"
 */
export function extractMfcIdFromHref(href: string): number | undefined {
  if (!href || href === '#') return undefined;
  const match = href.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Extract grouped entries (companies or artists) from a .data-field element.
 * Each .item-entries div contains one entity with optional role sub-element.
 */
export function extractGroupedEntries(
  $: cheerio.CheerioAPI,
  $field: cheerio.Cheerio<any>,
  defaultRole: string,
): Array<{ name: string; role: string; mfcId?: number }> {
  const entries: Array<{ name: string; role: string; mfcId?: number }> = [];

  $field.find('.item-entries').each((_, entryDiv) => {
    const $entry = $(entryDiv);
    const $link = $entry.find('a').first();
    const href = $link.attr('href') || '';

    // Name is in span[switch] or just the link text
    const name = $link.find('span[switch]').text().trim() || $link.text().trim();

    // Role is in <small class="light">as <em>Role</em></small>
    const rawRole = $entry.find('small.light em').text().trim() || defaultRole;
    const role = normalizeRole(rawRole);

    if (name) {
      entries.push({
        name,
        role,
        mfcId: extractMfcIdFromHref(href),
      });
    }
  });

  return entries;
}

/**
 * Extract entries from an individual-role .data-field element.
 * The label itself determines the role (e.g., "Sculptor" → role: "Sculptor").
 */
export function extractIndividualRoleEntries(
  $: cheerio.CheerioAPI,
  $field: cheerio.Cheerio<any>,
  role: string,
): Array<{ name: string; role: string; mfcId?: number }> {
  const entries: Array<{ name: string; role: string; mfcId?: number }> = [];

  $field.find('.item-entries a').each((_, link) => {
    const $link = $(link);
    const href = $link.attr('href') || '';
    const name = $link.find('span[switch]').text().trim() || $link.text().trim();

    if (name) {
      entries.push({
        name,
        role,
        mfcId: extractMfcIdFromHref(href),
      });
    }
  });

  return entries;
}

/**
 * Extract a text value from a .data-value element based on the strategy.
 * Standalone helper that handles all MFC HTML structures for text fields.
 */
export function extractTextValue(
  $: cheerio.CheerioAPI,
  $dataValue: cheerio.Cheerio<any>,
  strategy: ExtractionStrategy,
): string | undefined {
  // Materials: multiple linked entries joined by comma
  if (strategy === 'materials-field') {
    const materials: string[] = [];
    $dataValue.find('.item-entries a span[switch]').each((_, el) => {
      const text = $(el).text().trim();
      if (text) materials.push(text);
    });
    if (materials.length > 0) return materials.join(', ');
  }

  // Category: text in item-category span
  if (strategy === 'category-field') {
    const catSpan = $dataValue.find('span[class^="item-category"]');
    if (catSpan.length > 0) return catSpan.text().trim();
  }

  // Dimensions: scale + height sub-elements
  if (strategy === 'dimensions-field') {
    const parts: string[] = [];
    // Scale: <a class="item-scale"><small>1/</small>6</a>
    const scaleLink = $dataValue.find('a.item-scale');
    if (scaleLink.length > 0) {
      parts.push(scaleLink.text().trim());
    }
    // Height: <small>H=</small><strong>260</strong><small>mm</small>
    const heightStrong = $dataValue.find('strong');
    if (heightStrong.length > 0) {
      const height = heightStrong.text().trim();
      parts.push(`H=${height}mm`);
    }
    if (parts.length > 0) return parts.join(', ');
  }

  // Title/Version: direct <a switch="jp">English text</a>
  const directLink = $dataValue.children('a[switch]');
  if (directLink.length > 0) {
    return directLink.text().trim();
  }

  // Origin and others: <a><span switch="jp">English</span></a> in .item-entries
  const nestedSpan = $dataValue.find('.item-entries a span[switch]').first();
  if (nestedSpan.length > 0) {
    return nestedSpan.text().trim();
  }

  // Fallback: any link text
  const anyLink = $dataValue.find('a').first();
  if (anyLink.length > 0) {
    return anyLink.text().trim();
  }

  // Fallback: direct text content (excluding nested elements)
  return $dataValue.clone().children().remove().end().text().trim() || undefined;
}

/**
 * Extract tags from a tags-field .data-value element.
 */
function extractTags(
  $: cheerio.CheerioAPI,
  $dataValue: cheerio.Cheerio<any>,
): string[] {
  const tags: string[] = [];
  $dataValue.find('a').each((_, el) => {
    const tagText = $(el).text().trim();
    if (tagText) {
      tags.push(tagText);
    }
  });
  return tags;
}

// Strategy-to-field mapping for text-like strategies.
// Keys are lowercase singular forms; lookupTextField normalizes before matching.
const TEXT_FIELD_MAP: Record<string, keyof IMfcFieldData> = {
  title: 'title',
  origin: 'origin',
  version: 'version',
  classification: 'classification',
};

const COMMUNITY_COUNT_MAP: Record<string, keyof IMfcFieldData> = {
  'owned by': 'communityOwnedCount',
  'ordered by': 'communityOrderedCount',
  'wished by': 'communityWishedCount',
  'listed in': 'communityListedCount',
};

function extractCountFromText(text: string): number | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/,/g, '');
  const match = cleaned.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Normalize a label to match TEXT_FIELD_MAP keys.
 * Handles case insensitivity and singular/plural (e.g., "Classifications" → "classification").
 */
function lookupTextField(label: string): keyof IMfcFieldData | undefined {
  const lower = label.toLowerCase().replace(/s$/, '');
  return TEXT_FIELD_MAP[lower] || TEXT_FIELD_MAP[label.toLowerCase()];
}

/**
 * Extract company entries from MFC HTML.
 * Uses regex-based label matching for resilience against label variations.
 *
 * Dual strategy:
 * 1. Try grouped label ("Companies"/"Company" as grouped-entries)
 * 2. Fall back to individual role labels ("Distributor", "Retailer", "Publisher")
 * 3. Merge and dedupe results
 */
export function extractCompanies(html: string): ICompanyEntry[] {
  const $ = cheerio.load(html);
  const groupedEntries: ICompanyEntry[] = [];
  const individualEntries: ICompanyEntry[] = [];

  $('.data-field').each((_, fieldEl) => {
    const $field = $(fieldEl);
    const labelText = $field.find('.data-label').text().trim();
    if (!labelText) return;

    const match = lookupLabel(labelText);
    if (!match || match.category !== 'company') return;

    if (match.strategy === 'grouped-entries') {
      groupedEntries.push(...extractGroupedEntries($, $field, 'Manufacturer'));
    } else if (match.strategy === 'individual-role' && match.role) {
      individualEntries.push(...extractIndividualRoleEntries($, $field, match.role));
    }
  });

  return mergeAndDedupe(groupedEntries, individualEntries);
}

/**
 * Extract artist entries from MFC HTML.
 * Uses regex-based label matching for resilience against label variations.
 *
 * Dual strategy:
 * 1. Try grouped label ("Artists"/"Artist" as grouped-entries)
 * 2. Fall back to individual role labels ("Sculptor", "Illustrator", etc.)
 * 3. Merge and dedupe results
 */
export function extractArtists(html: string): IArtistEntry[] {
  const $ = cheerio.load(html);
  const groupedEntries: IArtistEntry[] = [];
  const individualEntries: IArtistEntry[] = [];

  $('.data-field').each((_, fieldEl) => {
    const $field = $(fieldEl);
    const labelText = $field.find('.data-label').text().trim();
    if (!labelText) return;

    const match = lookupLabel(labelText);
    if (!match || match.category !== 'artist') return;

    if (match.strategy === 'grouped-entries') {
      groupedEntries.push(...extractGroupedEntries($, $field, 'Unknown'));
    } else if (match.strategy === 'individual-role' && match.role) {
      individualEntries.push(...extractIndividualRoleEntries($, $field, match.role));
    }
  });

  return mergeAndDedupe(groupedEntries, individualEntries);
}

/**
 * Merge grouped and individual entries, deduplicating by name+role (case-insensitive).
 * Grouped entries take precedence (they have role sub-elements from the HTML).
 */
export function mergeAndDedupe<T extends { name: string; role: string }>(
  grouped: T[],
  individual: T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  // Add grouped entries first (higher precedence)
  for (const entry of grouped) {
    const key = `${entry.name.toLowerCase()}::${entry.role.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }

  // Add individual entries only if not already seen
  for (const entry of individual) {
    const key = `${entry.name.toLowerCase()}::${entry.role.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }

  return result;
}

/**
 * Extract all MFC-specific fields from the page HTML.
 * Uses a single loop over .data-field elements with registry-based dispatch.
 *
 * @param html - Raw HTML string from MFC page
 * @returns Object with extracted field values
 */
export function extractMfcFields(html: string): IMfcFieldData {
  const $ = cheerio.load(html);
  const fields: IMfcFieldData = {};
  const unknownLabels: string[] = [];

  $('.data-field').each((_, fieldEl) => {
    const $field = $(fieldEl);
    const labelText = $field.find('.data-label').text().trim();
    if (!labelText) return;

    const match = lookupLabel(labelText);

    if (!match) {
      unknownLabels.push(labelText);
      return;
    }

    const $dataValue = $field.find('.data-value');

    switch (match.strategy) {
      case 'text-field': {
        // Map label to field name (Title→title, Origin→origin, etc.)
        const fieldKey = lookupTextField(labelText);
        if (fieldKey) {
          const value = extractTextValue($, $dataValue, 'text-field');
          if (value) {
            (fields as Record<string, unknown>)[fieldKey] = value;
          }
        }
        break;
      }
      case 'category-field': {
        const value = extractTextValue($, $dataValue, 'category-field');
        if (value) fields.category = value;
        break;
      }
      case 'materials-field': {
        const value = extractTextValue($, $dataValue, 'materials-field');
        if (value) fields.materials = value;
        break;
      }
      case 'dimensions-field': {
        const value = extractTextValue($, $dataValue, 'dimensions-field');
        if (value) fields.dimensions = value;
        break;
      }
      case 'tags-field': {
        const tags = extractTags($, $dataValue);
        if (tags.length > 0) fields.tags = tags;
        break;
      }
      case 'community-count-field': {
        const fieldKey = COMMUNITY_COUNT_MAP[labelText.toLowerCase()];
        if (fieldKey) {
          const rawText = $dataValue.text().trim();
          const count = extractCountFromText(rawText);
          if (count !== undefined) {
            (fields as Record<string, unknown>)[fieldKey] = count;
          }
        }
        break;
      }
      case 'community-score-field': {
        const rawText = $dataValue.text().trim();
        const score = parseFloat(rawText);
        if (!isNaN(score) && score >= 0 && score <= 10) {
          fields.communityScore = score;
        }
        break;
      }
      // grouped-entries, individual-role, releases-field, skip:
      // handled by dedicated extractors (extractCompanies, extractArtists, extractReleases)
      default:
        break;
    }
  });

  if (unknownLabels.length > 0) {
    fields.unknownFields = unknownLabels;
  }

  return fields;
}

export interface IScrapedRelatedItem {
  mfcId: number;
  name?: string;
  imageUrl?: string;
  relationType?: string;
}

export function extractRelatedItems(html: string): IScrapedRelatedItem[] {
  const $ = cheerio.load(html);
  const items: IScrapedRelatedItem[] = [];

  // Related items are in .item-linked-group sections
  $('.item-linked-group').each((_, groupEl) => {
    const $group = $(groupEl);
    const relationType = $group.find('.item-linked-category').text().trim() || undefined;

    $group.find('.item-linked-item').each((_, itemEl) => {
      const $item = $(itemEl);
      const $link = $item.find('a[href*="/item/"]').first();
      const href = $link.attr('href') || '';
      const mfcId = extractMfcIdFromHref(href);

      if (!mfcId) return;

      const name = $link.attr('title') || $link.text().trim() || undefined;
      const $img = $item.find('img').first();
      const imageUrl = $img.attr('src') || undefined;

      items.push({ mfcId, name, imageUrl, relationType });
    });
  });

  return items;
}
