/**
 * Unit tests for Field Audit Collector
 *
 * The collector captures raw .data-field structures from MFC HTML pages
 * for analysis, identifying known/unknown labels and structural patterns.
 */

import { auditMfcFields, appendFieldAuditLog, type IFieldAuditEntry, type IFieldAuditResult } from '../../services/fieldAuditCollector';

describe('Field Audit Collector', () => {
  describe('auditMfcFields', () => {
    it('should identify all field labels in sample HTML', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123"><span switch>Good Smile Company</span></a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
        <div class="data-field">
          <div class="data-label">Origin</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/origin/456"><span switch>Fate/Grand Order</span></a>
            </div>
          </div>
        </div>
      `;

      const result = auditMfcFields(html, 12345);

      expect(result.mfcId).toBe(12345);
      expect(result.fields).toHaveLength(2);
      expect(result.fields[0].label).toBe('Companies');
      expect(result.fields[1].label).toBe('Origin');
    });

    it('should detect item-entries presence', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123"><span switch>GSC</span></a>
            </div>
          </div>
        </div>
        <div class="data-field">
          <div class="data-label">Category</div>
          <div class="data-value">
            <span class="item-category-1">Scale Figure</span>
          </div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.fields[0].hasItemEntries).toBe(true);
      expect(result.fields[1].hasItemEntries).toBe(false);
    });

    it('should detect role sub-elements', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123"><span switch>GSC</span></a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
        <div class="data-field">
          <div class="data-label">Sculptor</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/456"><span switch>Artist Name</span></a>
            </div>
          </div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.fields[0].hasRoleSubElements).toBe(true);
      expect(result.fields[0].roleTexts).toEqual(['Manufacturer']);
      expect(result.fields[1].hasRoleSubElements).toBe(false);
      expect(result.fields[1].roleTexts).toBeUndefined();
    });

    it('should capture multiple role texts from grouped entries', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/1"><span switch>Artist A</span></a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/2"><span switch>Artist B</span></a>
              <small class="light">as <em>Color producers</em></small>
            </div>
          </div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.fields[0].roleTexts).toEqual(['Sculptor', 'Color producers']);
    });

    it('should count entries per field', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/1"><span switch>Company A</span></a>
            </div>
            <div class="item-entries">
              <a href="/entry/2"><span switch>Company B</span></a>
            </div>
            <div class="item-entries">
              <a href="/entry/3"><span switch>Company C</span></a>
            </div>
          </div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.fields[0].entryCount).toBe(3);
    });

    it('should capture value preview', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Origin</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/origin/1"><span switch>Fate/Grand Order</span></a>
            </div>
          </div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.fields[0].valuePreview).toContain('Fate/Grand Order');
    });

    it('should truncate long value previews to 100 chars', () => {
      const longText = 'A'.repeat(200);
      const html = `
        <div class="data-field">
          <div class="data-label">Origin</div>
          <div class="data-value">${longText}</div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.fields[0].valuePreview.length).toBeLessThanOrEqual(100);
    });

    it('should flag unknown labels', () => {
      const html = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">test</div>
        </div>
        <div class="data-field">
          <div class="data-label">SomeNewField</div>
          <div class="data-value">test</div>
        </div>
        <div class="data-field">
          <div class="data-label">AnotherUnknown</div>
          <div class="data-value">test</div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      expect(result.unknownLabels).toEqual(['SomeNewField', 'AnotherUnknown']);
    });

    it('should return empty arrays for HTML without data-fields', () => {
      const html = '<div>No data fields here</div>';

      const result = auditMfcFields(html, 1);

      expect(result.fields).toEqual([]);
      expect(result.unknownLabels).toEqual([]);
    });

    it('should handle empty HTML', () => {
      const result = auditMfcFields('', 1);

      expect(result.fields).toEqual([]);
      expect(result.unknownLabels).toEqual([]);
    });

    it('should handle data-field with empty label', () => {
      const html = `
        <div class="data-field">
          <div class="data-label"></div>
          <div class="data-value">some value</div>
        </div>
      `;

      const result = auditMfcFields(html, 1);

      // Empty labels are still captured in fields but flagged as unknown
      expect(result.fields).toHaveLength(0);
    });

    it('should include timestamp in result', () => {
      const result = auditMfcFields('<div></div>', 1);
      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('appendFieldAuditLog', () => {
    it('should convert audit result to JSONL string', () => {
      const result: IFieldAuditResult = {
        mfcId: 12345,
        timestamp: '2026-02-21T00:00:00.000Z',
        fields: [
          {
            label: 'Companies',
            hasItemEntries: true,
            hasRoleSubElements: true,
            entryCount: 1,
            valuePreview: 'Good Smile Company',
          },
        ],
        unknownLabels: [],
      };

      const jsonl = appendFieldAuditLog(result);

      expect(jsonl).toBeDefined();
      const parsed = JSON.parse(jsonl);
      expect(parsed.mfcId).toBe(12345);
      expect(parsed.fields).toHaveLength(1);
    });
  });
});
