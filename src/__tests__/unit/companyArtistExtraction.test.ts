/**
 * Unit tests for Schema v3 Company/Artist extraction from MFC pages
 *
 * MFC HTML Structure (current implementation):
 * - Companies field: A single .data-field with .data-label "Companies"
 *   containing one .item-entries per company, each with an <a> link,
 *   <span switch> for name, and <small class="light">as <em>Role</em></small> for role.
 * - Artists field: A single .data-field with .data-label "Artists"
 *   containing one .item-entries per artist, with same structure.
 */

import { extractCompanies, extractArtists, ICompanyEntry, IArtistEntry } from '../../services/companyArtistExtractor';

describe('MFC Company Extraction', () => {
  describe('extractCompanies', () => {
    it('should extract single company from Companies data-field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123">
                <span switch>Good Smile Company</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies).toHaveLength(1);
      expect(companies[0]).toEqual({
        name: 'Good Smile Company',
        role: 'Manufacturer',
        mfcId: 123
      });
    });

    it('should extract multiple companies from single Companies field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123">
                <span switch>Good Smile Company</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/456">
                <span switch>Max Factory</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies).toHaveLength(2);
      expect(companies[0].name).toBe('Good Smile Company');
      expect(companies[1].name).toBe('Max Factory');
    });

    it('should extract company with Distributor role', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/789">
                <span switch>AmiAmi</span>
              </a>
              <small class="light">as <em>Distributor</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies).toHaveLength(1);
      expect(companies[0]).toEqual({
        name: 'AmiAmi',
        role: 'Distributor',
        mfcId: 789
      });
    });

    it('should extract companies with different roles from Companies field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123">
                <span switch>Good Smile Company</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/456">
                <span switch>AmiAmi</span>
              </a>
              <small class="light">as <em>Distributor</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies).toHaveLength(2);
      expect(companies.find(c => c.name === 'Good Smile Company')?.role).toBe('Manufacturer');
      expect(companies.find(c => c.name === 'AmiAmi')?.role).toBe('Distributor');
    });

    it('should handle missing company data gracefully', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Character</div>
          <div class="data-value">Hatsune Miku</div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies).toEqual([]);
    });

    it('should extract MFC ID from href', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/98765">
                <span switch>Alter</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies[0].mfcId).toBe(98765);
    });

    it('should handle company without MFC ID in href', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="#">
                <span switch>Unknown Company</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);

      expect(companies).toHaveLength(1);
      expect(companies[0].name).toBe('Unknown Company');
      expect(companies[0].mfcId).toBeUndefined();
    });
  });
});

describe('MFC Artist Extraction', () => {
  describe('extractArtists', () => {
    it('should extract sculptor from Artists data-field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>TERAOKA Takeyuki</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toHaveLength(1);
      expect(artists[0]).toEqual({
        name: 'TERAOKA Takeyuki',
        role: 'Sculptor',
        mfcId: 111
      });
    });

    it('should extract illustrator from Artists data-field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/222">
                <span switch>KEI</span>
              </a>
              <small class="light">as <em>Illustrator</em></small>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toHaveLength(1);
      expect(artists[0]).toEqual({
        name: 'KEI',
        role: 'Illustrator',
        mfcId: 222
      });
    });

    it('should extract multiple artists with different roles', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>TERAOKA Takeyuki</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/222">
                <span switch>KEI</span>
              </a>
              <small class="light">as <em>Illustrator</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/333">
                <span switch>Finishing Master</span>
              </a>
              <small class="light">as <em>Painter</em></small>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toHaveLength(3);
      expect(artists.find(a => a.role === 'Sculptor')?.name).toBe('TERAOKA Takeyuki');
      expect(artists.find(a => a.role === 'Illustrator')?.name).toBe('KEI');
      expect(artists.find(a => a.role === 'Painter')?.name).toBe('Finishing Master');
    });

    it('should extract multiple sculptors from single Artists field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>Artist A</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
            <div class="item-entries">
              <a href="/entry/222">
                <span switch>Artist B</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toHaveLength(2);
      expect(artists[0].name).toBe('Artist A');
      expect(artists[0].role).toBe('Sculptor');
      expect(artists[1].name).toBe('Artist B');
      expect(artists[1].role).toBe('Sculptor');
    });

    it('should handle Designer role', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/444">
                <span switch>Original Designer</span>
              </a>
              <small class="light">as <em>Designer</em></small>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toHaveLength(1);
      expect(artists[0].role).toBe('Designer');
    });

    it('should handle missing artist data gracefully', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123">
                <span switch>Good Smile Company</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toEqual([]);
    });

    it('should default to Unknown role when role element is missing', () => {
      // When no <small class="light">as <em>Role</em></small> is present,
      // the code defaults the role to "Unknown"
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/555">
                <span switch>Original Artist</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);

      expect(artists).toHaveLength(1);
      expect(artists[0].role).toBe('Unknown');  // Defaults to 'Unknown' when no role element
    });
  });
});

describe('Label Variation Resilience', () => {
  describe('singular vs plural labels', () => {
    it('should extract company from singular "Company" label', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Company</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123">
                <span switch>Good Smile Company</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);
      expect(companies).toHaveLength(1);
      expect(companies[0].name).toBe('Good Smile Company');
      expect(companies[0].role).toBe('Manufacturer');
    });

    it('should extract artist from singular "Artist" label', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artist</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>TERAOKA Takeyuki</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);
      expect(artists).toHaveLength(1);
      expect(artists[0].name).toBe('TERAOKA Takeyuki');
    });
  });

  describe('individual role fields (fallback extraction)', () => {
    it('should extract company from standalone "Distributor" field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Distributor</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/789">
                <span switch>AmiAmi</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);
      expect(companies).toHaveLength(1);
      expect(companies[0].name).toBe('AmiAmi');
      expect(companies[0].role).toBe('Distributor');
    });

    it('should extract artist from standalone "Sculptor" field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Sculptor</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>TERAOKA Takeyuki</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);
      expect(artists).toHaveLength(1);
      expect(artists[0].name).toBe('TERAOKA Takeyuki');
      expect(artists[0].role).toBe('Sculptor');
    });

    it('should extract artist from "Original Illustrator" field', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Original Illustrator</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/222">
                <span switch>KEI</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);
      expect(artists).toHaveLength(1);
      expect(artists[0].name).toBe('KEI');
      expect(artists[0].role).toBe('Illustrator');
    });

    it('should extract multiple companies from different individual role fields', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Distributor</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/789"><span switch>AmiAmi</span></a>
            </div>
          </div>
        </div>
        <div class="data-field">
          <div class="data-label">Retailer</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/456"><span switch>HobbySearch</span></a>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);
      expect(companies).toHaveLength(2);
      expect(companies.find(c => c.name === 'AmiAmi')?.role).toBe('Distributor');
      expect(companies.find(c => c.name === 'HobbySearch')?.role).toBe('Retailer');
    });
  });

  describe('mixed grouped + individual (dedup)', () => {
    it('should merge grouped and individual entries, deduplicating', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>TERAOKA Takeyuki</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
          </div>
        </div>
        <div class="data-field">
          <div class="data-label">Sculptor</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>TERAOKA Takeyuki</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);
      // Should deduplicate: same name + role from grouped and individual
      expect(artists).toHaveLength(1);
      expect(artists[0].name).toBe('TERAOKA Takeyuki');
      expect(artists[0].role).toBe('Sculptor');
    });

    it('should keep entries with different roles from grouped and individual', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">Artists</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/111">
                <span switch>Artist A</span>
              </a>
              <small class="light">as <em>Sculptor</em></small>
            </div>
          </div>
        </div>
        <div class="data-field">
          <div class="data-label">Illustrator</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/222">
                <span switch>Artist B</span>
              </a>
            </div>
          </div>
        </div>
      `;

      const artists = extractArtists(mockHtml);
      expect(artists).toHaveLength(2);
      expect(artists.find(a => a.name === 'Artist A')?.role).toBe('Sculptor');
      expect(artists.find(a => a.name === 'Artist B')?.role).toBe('Illustrator');
    });
  });

  describe('case insensitivity', () => {
    it('should handle lowercase "companies" label', () => {
      const mockHtml = `
        <div class="data-field">
          <div class="data-label">companies</div>
          <div class="data-value">
            <div class="item-entries">
              <a href="/entry/123">
                <span switch>Test Company</span>
              </a>
              <small class="light">as <em>Manufacturer</em></small>
            </div>
          </div>
        </div>
      `;

      const companies = extractCompanies(mockHtml);
      expect(companies).toHaveLength(1);
      expect(companies[0].name).toBe('Test Company');
    });
  });
});

describe('Unknown Field Detection (extractMfcFields)', () => {
  it('should capture unknown labels in unknownFields', () => {
    const mockHtml = `
      <div class="data-field">
        <div class="data-label">Title</div>
        <div class="data-value"><a switch="jp">Test Figure</a></div>
      </div>
      <div class="data-field">
        <div class="data-label">SomeNewField</div>
        <div class="data-value">unknown value</div>
      </div>
    `;

    const { extractMfcFields } = require('../../services/companyArtistExtractor');
    const fields = extractMfcFields(mockHtml);
    expect(fields.title).toBe('Test Figure');
    expect(fields.unknownFields).toEqual(['SomeNewField']);
  });
});

describe('Combined Extraction (ScrapedData v3)', () => {
  it('should return empty arrays for page without company or artist data', () => {
    const mockHtml = `
      <div class="data-field">
        <div class="data-label">Character</div>
        <div class="data-value">Hatsune Miku</div>
      </div>
    `;

    const companies = extractCompanies(mockHtml);
    const artists = extractArtists(mockHtml);

    expect(companies).toEqual([]);
    expect(artists).toEqual([]);
  });
});
