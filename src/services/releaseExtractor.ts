import { load, CheerioAPI } from 'cheerio';
import { lookupLabel } from './mfcLabelRegistry';

export interface IRelease {
  date?: Date;
  price?: number;
  currency?: string;
  isRerelease: boolean;
  jan?: string;  // JAN/EAN/UPC barcode (10-13 digits)
  variant?: string;  // e.g., "Limited (China)", "Standard (China)", "Regular"
}

/**
 * Extracts release information from MFC HTML
 *
 * MFC Structure (observed patterns):
 * 1. Single release: .data-field with .data-label "Releases" containing release data
 * 2. Multiple releases: First block has "Releases" label, subsequent sibling blocks
 *    may appear without the label but contain the same release data structure
 *
 * Release data within .data-value:
 * - Date: <a class="time">MM/DD/YYYY</a>
 * - Type: <small class="light">as <em>Limited (China)</em></small>
 * - Price: raw number + <small>CNY/JPY/USD...</small>
 * - JAN: <a title="Buy (JAN)">JAN</a> or <meta itemprop="productID" content="jan:...">
 *
 * @param html - The HTML content containing release information
 * @returns Array of releases with the first marked as original, rest as rereleases
 */
export function extractReleases(html: string): IRelease[] {
  const $ = load(html);
  const releases: IRelease[] = [];

  // Find the "Releases" data-field (registry-based matching for label resilience)
  const releasesField = $('.data-field').filter((_, el) => {
    const label = $(el).find('.data-label').text().trim();
    const match = lookupLabel(label);
    return match?.strategy === 'releases-field';
  });

  if (releasesField.length === 0) {
    return releases;
  }

  // Extract from the main Releases field
  const dataValue = releasesField.find('.data-value');
  const firstRelease = extractReleaseFromValue($, dataValue);
  if (firstRelease) {
    firstRelease.isRerelease = false;
    releases.push(firstRelease);
  }

  // Check for sibling data-fields that might be additional releases
  // MFC sometimes puts multiple releases as sibling .data-field elements
  // without the "Releases" label
  let nextSibling = releasesField.next('.data-field');
  while (nextSibling.length > 0) {
    const label = nextSibling.find('.data-label').text().trim();

    // If we hit a labeled field that isn't a release, stop looking
    if (label) {
      const siblingMatch = lookupLabel(label);
      if (siblingMatch?.strategy !== 'releases-field') {
        break;
      }
    }

    // If no label or label is "Releases", try to extract release data
    const siblingValue = nextSibling.find('.data-value');

    // Check if this looks like release data (has a date link with class "time")
    if (siblingValue.find('a.time').length > 0) {
      const additionalRelease = extractReleaseFromValue($, siblingValue);
      if (additionalRelease) {
        additionalRelease.isRerelease = true;
        releases.push(additionalRelease);
      }
    } else {
      // Doesn't look like release data, stop
      break;
    }

    nextSibling = nextSibling.next('.data-field');
  }

  return releases;
}

/**
 * Extract release data from a .data-value element
 *
 * Expected structure:
 * <a class="time">10/09/2025</a>
 * <small class="light">as <em>Limited (China)</em></small><br>
 * 3,280.00 <small>CNY (<a href="...">USD</a>)</small>
 * [optional] • <a title="Buy (JAN)">JAN</a>
 * [optional] <meta itemprop="productID" content="jan:...">
 */
function extractReleaseFromValue($: CheerioAPI, dataValue: ReturnType<CheerioAPI>): IRelease | null {
  // Extract date from <a class="time">
  const dateLink = dataValue.find('a.time').first();
  const dateText = dateLink.text().trim();
  const date = parseMfcDate(dateText);

  // If no date found, this isn't a valid release entry
  if (!date) {
    return null;
  }

  // Extract variant from <small class="light">as <em>TYPE</em></small>
  const typeSmall = dataValue.find('small.light em').first();
  const variant = typeSmall.text().trim() || undefined;

  // Extract price and currency
  // Format: "3,280.00 <small>CNY...</small>" or "¥12,800 <small>JPY...</small>"
  const { price, currency } = extractPriceFromValue($, dataValue);

  // Extract JAN from multiple possible locations:
  // 1. <a title="Buy (JAN)">JAN</a>
  // 2. <meta itemprop="productID" content="jan:JAN">
  const jan = extractJanFromValue($, dataValue);

  return {
    date,
    price,
    currency,
    isRerelease: false, // Will be set by caller
    jan,
    variant,
  };
}

/**
 * Parse MFC date format to Date object
 * Supports:
 * - MM/DD/YYYY (full date, e.g., "10/09/2025")
 * - MM/YYYY (month/year only, e.g., "08/2023") - day defaults to 1
 */
function parseMfcDate(dateText: string): Date | undefined {
  if (!dateText) {
    return undefined;
  }

  // Try MM/DD/YYYY format first (full date)
  const fullMatch = dateText.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (fullMatch) {
    const [, month, day, year] = fullMatch;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    // Validate the date is real
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // Try MM/YYYY format (month/year only - common for items without specific release day)
  const monthYearMatch = dateText.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYearMatch) {
    const [, month, year] = monthYearMatch;
    // Default to first day of month
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    // Validate the date is real
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // Try parsing as-is for other formats
  const parsed = new Date(dateText);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Extract price and currency from the data-value content
 *
 * Patterns observed:
 * - "3,280.00 <small>CNY (...)</small>"
 * - "¥12,800 <small>JPY</small>"
 * - "999.00 <small>CNY (...)</small>"
 */
function extractPriceFromValue($: CheerioAPI, dataValue: ReturnType<CheerioAPI>): { price?: number; currency?: string } {
  // Get the currency from the <small> element after the price
  const currencySmalls = dataValue.find('small').filter((_, el) => {
    const text = $(el).text().trim().toUpperCase();
    // Look for currency codes
    return /^(JPY|CNY|USD|EUR|GBP|KRW|TWD|HKD)/.test(text);
  });

  let currency: string | undefined;
  if (currencySmalls.length > 0) {
    const currencyText = currencySmalls.first().text().trim().toUpperCase();
    // Extract just the currency code
    const currencyMatch = currencyText.match(/^(JPY|CNY|USD|EUR|GBP|KRW|TWD|HKD)/);
    if (currencyMatch) {
      currency = currencyMatch[1];
    }
  }

  // Get the raw text content and extract the price number
  // Clone to avoid modifying the original, then remove child elements to get text nodes
  const clone = dataValue.clone();
  clone.find('a, small, meta, br').remove();
  const textContent = clone.text().trim();

  // Look for price pattern: digits with optional commas and decimal
  // Price appears before the currency <small> element
  const priceMatch = textContent.match(/([\d,]+\.?\d*)/);
  let price: number | undefined;
  if (priceMatch) {
    const priceText = priceMatch[1].replace(/,/g, '');
    price = parseFloat(priceText);
    if (isNaN(price)) {
      price = undefined;
    }
  }

  // If no currency found in <small>, check for currency symbols in the text
  if (!currency && textContent) {
    const symbolMap: Record<string, string> = {
      '¥': 'JPY',  // Could be JPY or CNY, but JPY more common on MFC
      '$': 'USD',
      '€': 'EUR',
      '£': 'GBP',
      '₩': 'KRW',
    };
    for (const [symbol, code] of Object.entries(symbolMap)) {
      if (textContent.includes(symbol)) {
        currency = code;
        break;
      }
    }
  }

  return { price, currency };
}

/**
 * Extract JAN/UPC barcode from various MFC formats
 *
 * Patterns:
 * 1. <a class="tbx-window" title="Buy (6971804910250)">6971804910250</a>
 * 2. <meta itemprop="productID" content="jan:6971804910250">
 */
function extractJanFromValue(_$: CheerioAPI, dataValue: ReturnType<CheerioAPI>): string | undefined {
  // Try meta tag first (more reliable)
  const metaTag = dataValue.find('meta[itemprop="productID"]');
  if (metaTag.length > 0) {
    const content = metaTag.attr('content') || '';
    const janMatch = content.match(/jan:(\d+)/);
    if (janMatch) {
      return validateJAN(janMatch[1]);
    }
  }

  // Try title attribute on buy link
  const buyLink = dataValue.find('a[title^="Buy"]');
  if (buyLink.length > 0) {
    const title = buyLink.attr('title') || '';
    const janMatch = title.match(/Buy\s*\((\d+)\)/);
    if (janMatch) {
      return validateJAN(janMatch[1]);
    }
    // Also try the link text itself
    const linkText = buyLink.text().trim();
    return validateJAN(linkText);
  }

  // Try tbx-window class links (common MFC pattern)
  const tbxLink = dataValue.find('a.tbx-window');
  if (tbxLink.length > 0) {
    const linkText = tbxLink.text().trim();
    // Extract just digits
    const digits = linkText.replace(/\D/g, '');
    return validateJAN(digits);
  }

  return undefined;
}

/**
 * Validates JAN/EAN/UPC barcode
 * Valid codes are 8-14 digits (covers UPC-A, EAN-8, EAN-13, JAN, ITF-14)
 *
 * @param janText - The JAN text from HTML
 * @returns Valid JAN code or undefined if invalid
 */
function validateJAN(janText: string): string | undefined {
  if (!janText) {
    return undefined;
  }

  // Remove any non-digit characters
  const digits = janText.replace(/\D/g, '');

  // Valid barcodes are 8-14 digits
  // UPC-A: 12 digits
  // EAN-8: 8 digits
  // EAN-13/JAN: 13 digits
  // ITF-14: 14 digits
  if (digits.length >= 8 && digits.length <= 14) {
    return digits;
  }

  return undefined;
}
