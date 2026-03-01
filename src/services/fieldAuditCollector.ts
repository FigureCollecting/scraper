/**
 * Field Audit Collector - Captures raw .data-field structures from MFC HTML
 *
 * Used for analyzing real MFC page patterns to discover label variations,
 * HTML structure differences, and unknown field types.
 *
 * Enable with MFC_FIELD_AUDIT=true environment variable.
 * Results are appended to logs/field-audit.jsonl as one JSON object per line.
 */

import * as cheerio from 'cheerio';
import { lookupLabel } from './mfcLabelRegistry';

export interface IFieldAuditEntry {
  label: string;                // Raw .data-label text
  hasItemEntries: boolean;      // .item-entries present?
  hasRoleSubElements: boolean;  // <small class="light">as <em>...</em></small>?
  entryCount: number;           // Number of .item-entries elements
  valuePreview: string;         // First 100 chars of .data-value text
  roleTexts?: string[];         // Raw role text from <em> sub-elements (if present)
}

export interface IFieldAuditResult {
  mfcId: number;
  timestamp: string;
  fields: IFieldAuditEntry[];
  unknownLabels: string[];      // Labels not in registry
}

const VALUE_PREVIEW_MAX_LENGTH = 100;

/**
 * Audit all .data-field elements in MFC HTML, capturing structure info
 * and flagging labels not recognized by the registry.
 */
export function auditMfcFields(html: string, mfcId: number): IFieldAuditResult {
  const $ = cheerio.load(html);
  const fields: IFieldAuditEntry[] = [];
  const unknownLabels: string[] = [];

  $('.data-field').each((_, fieldEl) => {
    const $field = $(fieldEl);
    const label = $field.find('.data-label').text().trim();

    if (!label) return;

    const $dataValue = $field.find('.data-value');
    const valueText = $dataValue.text().trim();
    const $itemEntries = $field.find('.item-entries');

    // Capture role sub-element text for grouped entries analysis
    const $roleEms = $field.find('small.light em');
    const hasRoles = $roleEms.length > 0;
    const roleTexts: string[] = [];
    if (hasRoles) {
      $roleEms.each((_, em) => {
        const text = $(em).text().trim();
        if (text) roleTexts.push(text);
      });
    }

    const entry: IFieldAuditEntry = {
      label,
      hasItemEntries: $itemEntries.length > 0,
      hasRoleSubElements: hasRoles,
      entryCount: $itemEntries.length,
      valuePreview: valueText.substring(0, VALUE_PREVIEW_MAX_LENGTH),
    };
    if (roleTexts.length > 0) {
      entry.roleTexts = roleTexts;
    }
    fields.push(entry);

    // Check if this label is recognized by the registry
    const match = lookupLabel(label);
    if (!match) {
      unknownLabels.push(label);
    }
  });

  return {
    mfcId,
    timestamp: new Date().toISOString(),
    fields,
    unknownLabels,
  };
}

/**
 * Convert an audit result to a JSONL line for appending to the log file.
 * Returns the JSON string (caller handles file I/O).
 */
export function appendFieldAuditLog(result: IFieldAuditResult): string {
  return JSON.stringify(result);
}
