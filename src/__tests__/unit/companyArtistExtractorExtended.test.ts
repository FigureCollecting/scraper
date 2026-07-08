/**
 * Extended unit tests for Company/Artist Extractor
 * Covers extractMfcFields and extractTextField branches
 */
import { extractCompanies, extractArtists, extractMfcFields, IMfcFieldData } from '../../services/companyArtistExtractor';

describe('companyArtistExtractor - extended', () => {
  // ============================================================================
  // extractCompanies - Companies field format
  // ============================================================================

  describe('extractCompanies', () => {
    it('should extract company with role from HTML', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Companies</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/79559"><span switch="ロケットボーイ">Rocket Boy</span></a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;
      const companies = extractCompanies(html);
      expect(companies).toHaveLength(1);
      expect(companies[0].name).toBe('Rocket Boy');
      expect(companies[0].role).toBe('Manufacturer');
      expect(companies[0].mfcId).toBe(79559);
    });

    it('should extract multiple companies', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Companies</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/100"><span switch="JP">Company A</span></a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/200"><span switch="JP">Company B</span></a>
              <small class="light">as <em>Distributor</em></small>
            </div>
          </div>
        </div>
      `;
      const companies = extractCompanies(html);
      expect(companies).toHaveLength(2);
      expect(companies[0].role).toBe('Manufacturer');
      expect(companies[1].role).toBe('Distributor');
    });

    it('should return empty array for no companies field', () => {
      const html = '<div class="data-field"><span class="data-label">Title</span></div>';
      expect(extractCompanies(html)).toEqual([]);
    });

    it('should default role to Manufacturer when no role specified', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Companies</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123"><span switch="JP">Some Company</span></a>
            </div>
          </div>
        </div>
      `;
      const companies = extractCompanies(html);
      expect(companies).toHaveLength(1);
      expect(companies[0].role).toBe('Manufacturer');
    });

    it('should use link text when span[switch] is missing', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Companies</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/456">Fallback Name</a>
              <small class="light">as <em>Retailer</em></small>
            </div>
          </div>
        </div>
      `;
      const companies = extractCompanies(html);
      expect(companies).toHaveLength(1);
      expect(companies[0].name).toBe('Fallback Name');
      expect(companies[0].role).toBe('Retailer');
    });

    it('should handle href with no ID', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Companies</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="#"><span switch="JP">No ID Company</span></a>
            </div>
          </div>
        </div>
      `;
      const companies = extractCompanies(html);
      expect(companies).toHaveLength(1);
      expect(companies[0].mfcId).toBeUndefined();
    });

    it('should skip entries with no name', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Companies</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123"></a>
            </div>
          </div>
        </div>
      `;
      const companies = extractCompanies(html);
      expect(companies).toHaveLength(0);
    });
  });

  // ============================================================================
  // extractArtists
  // ============================================================================

  describe('extractArtists', () => {
    it('should extract artist with role', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Artists</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/555"><span switch="JP名">Artist Name</span></a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
          </div>
        </div>
      `;
      const artists = extractArtists(html);
      expect(artists).toHaveLength(1);
      expect(artists[0].name).toBe('Artist Name');
      expect(artists[0].role).toBe('Sculptor');
      expect(artists[0].mfcId).toBe(555);
    });

    it('should extract multiple artists with different roles', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Artists</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/1"><span switch="JP">Sculptor A</span></a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/2"><span switch="JP">Painter B</span></a>
              <small class="light">as <em>Painter</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/3"><span switch="JP">Illustrator C</span></a>
              <small class="light">as <em>Illustrator</em></small>
            </div>
          </div>
        </div>
      `;
      const artists = extractArtists(html);
      expect(artists).toHaveLength(3);
      expect(artists[0].role).toBe('Sculptor');
      expect(artists[1].role).toBe('Painter');
      expect(artists[2].role).toBe('Illustrator');
    });

    it('should return empty array for no artists field', () => {
      const html = '<div class="data-field"><span class="data-label">Title</span></div>';
      expect(extractArtists(html)).toEqual([]);
    });

    it('should default role to Unknown when no role specified', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Artists</span>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/1"><span switch="JP">Unknown Role Artist</span></a>
            </div>
          </div>
        </div>
      `;
      const artists = extractArtists(html);
      expect(artists).toHaveLength(1);
      expect(artists[0].role).toBe('Unknown');
    });
  });

  // ============================================================================
  // extractMfcFields
  // ============================================================================

  describe('extractMfcFields', () => {
    it('should extract title from a[switch]', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Title</span>
          <span class="data-value"><a switch="JP名前">English Title</a></span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.title).toBe('English Title');
    });

    it('should extract origin from nested span[switch]', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Origin</span>
          <span class="data-value">
            <span class="item-entries">
              <a href="/entry/123"><span switch="JP名">Fate/Grand Order</span></a>
            </span>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.origin).toBe('Fate/Grand Order');
    });

    it('should extract version', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Version</span>
          <span class="data-value"><a switch="JP">Little Devil Ver.</a></span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.version).toBe('Little Devil Ver.');
    });

    it('should extract category from item-category span', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Category</span>
          <span class="data-value">
            <span class="item-category-1">Scale Figure</span>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.category).toBe('Scale Figure');
    });

    it('should extract classification', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Classification</span>
          <span class="data-value"><a href="/browse">Goods</a></span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.classification).toBe('Goods');
    });

    it('should extract materials from multiple entries', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Materials</span>
          <span class="data-value">
            <span class="item-entries">
              <a href="/"><span switch="JP">PVC</span></a>
            </span>
            <span class="item-entries">
              <a href="/"><span switch="JP">ABS</span></a>
            </span>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.materials).toBe('PVC, ABS');
    });

    it('should extract dimensions with scale and height', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <a class="item-scale"><small>1/</small>6</a>
            <small>H=</small><strong>260</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toContain('1/6');
      expect(fields.dimensions).toContain('H=260mm');
    });

    it('should extract dimensions with only scale', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <a class="item-scale"><small>1/</small>7</a>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toContain('1/7');
    });

    it('should extract dimensions with only height', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>H=</small><strong>150</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('H=150mm');
    });

    // Multi-dimension figures: MFC renders each labeled dimension as its own
    // <small>LABEL=</small><strong>value</strong><small>unit</small> triple.
    // The previous parser ran find('strong').text() across ALL strongs, which
    // Cheerio concatenates (e.g. 250+210+470 -> "250210470") and then mislabeled
    // the blob as height. Each dimension must be captured separately by its label.
    it('should extract multi-dimension figure without concatenating values (Mahina W/L/H)', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <a class="item-scale"><small>1/</small>6</a>
            <small>W=</small><strong>250</strong><small>mm</small>
            <small>L=</small><strong>210</strong><small>mm</small>
            <small>H=</small><strong>470</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('1/6, W=250mm, L=210mm, H=470mm');
      // Regression guard: the corrupted concatenation must never appear.
      expect(fields.dimensions).not.toContain('250210470');
    });

    it('should keep height labeled correctly for Yan (W=320 L=330 H=420)', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>W=</small><strong>320</strong><small>mm</small>
            <small>L=</small><strong>330</strong><small>mm</small>
            <small>H=</small><strong>420</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('W=320mm, L=330mm, H=420mm');
      expect(fields.dimensions).not.toContain('320330420');
    });

    it('should handle a four-dimension figure including depth (W/L/H/D)', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>W=</small><strong>195</strong><small>mm</small>
            <small>L=</small><strong>225</strong><small>mm</small>
            <small>H=</small><strong>242</strong><small>mm</small>
            <small>D=</small><strong>90</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('W=195mm, L=225mm, H=242mm, D=90mm');
    });

    it('should accept full-word labels (Width/Length/Height)', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>Width=</small><strong>100</strong><small>mm</small>
            <small>Height=</small><strong>200</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('W=100mm, H=200mm');
    });

    it('should convert centimeters to millimeters', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>H=</small><strong>26</strong><small>cm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('H=260mm');
    });

    it('should convert inches to millimeters', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>H=</small><strong>10</strong><small>in</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('H=254mm');
    });

    it('should skip unrecognized dimension labels instead of fabricating height', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>X=</small><strong>999</strong><small>mm</small>
            <small>H=</small><strong>300</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('H=300mm');
      expect(fields.dimensions).not.toContain('999');
    });

    it('should keep fractional millimeters when converting inches', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>H=</small><strong>9.5</strong><small>in</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('H=241.3mm');
    });

    it('should skip a dimension whose value is not numeric', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Dimensions</span>
          <span class="data-value">
            <small>W=</small><strong>n/a</strong><small>mm</small>
            <small>H=</small><strong>200</strong><small>mm</small>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.dimensions).toBe('H=200mm');
    });

    it('should extract tags from Various field', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Various</span>
          <span class="data-value">
            <a href="/?_tb=item&ratingId=3">18+</a>
            <a href="/?_tb=item&isCastoff=1">Castoff</a>
            <a href="/?_tb=item&isLimited=1">Limited</a>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.tags).toEqual(['18+', 'Castoff', 'Limited']);
    });

    it('should return undefined for missing fields', () => {
      const html = '<div></div>';
      const fields = extractMfcFields(html);
      expect(fields.title).toBeUndefined();
      expect(fields.origin).toBeUndefined();
      expect(fields.version).toBeUndefined();
      expect(fields.category).toBeUndefined();
      expect(fields.classification).toBeUndefined();
      expect(fields.materials).toBeUndefined();
      expect(fields.dimensions).toBeUndefined();
      expect(fields.tags).toBeUndefined();
    });

    it('should extract fallback text from data-value', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Classification</span>
          <span class="data-value">Plain Text Value</span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.classification).toBe('Plain Text Value');
    });

    it('should handle complete MFC page with all fields', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Title</span>
          <span class="data-value"><a switch="JP">Mash Kyrielight</a></span>
        </div>
        <div class="data-field">
          <span class="data-label">Origin</span>
          <span class="data-value">
            <span class="item-entries"><a href="/entry/1"><span switch="JP">Fate/Grand Order</span></a></span>
          </span>
        </div>
        <div class="data-field">
          <span class="data-label">Category</span>
          <span class="data-value"><span class="item-category-1">Scale Figure</span></span>
        </div>
        <div class="data-field">
          <span class="data-label">Materials</span>
          <span class="data-value">
            <span class="item-entries"><a href="/"><span switch="JP">PVC</span></a></span>
          </span>
        </div>
        <div class="data-field">
          <span class="data-label">Various</span>
          <span class="data-value">
            <a href="/">Limited</a>
          </span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.title).toBe('Mash Kyrielight');
      expect(fields.origin).toBe('Fate/Grand Order');
      expect(fields.category).toBe('Scale Figure');
      expect(fields.materials).toBe('PVC');
      expect(fields.tags).toEqual(['Limited']);
    });

    it('should not include tags when Various field has no links', () => {
      const html = `
        <div class="data-field">
          <span class="data-label">Various</span>
          <span class="data-value"></span>
        </div>
      `;
      const fields = extractMfcFields(html);
      expect(fields.tags).toBeUndefined();
    });
  });
});
