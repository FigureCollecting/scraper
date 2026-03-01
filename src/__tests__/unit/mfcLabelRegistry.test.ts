/**
 * Unit tests for MFC Label Registry
 *
 * The registry maps MFC HTML data-field labels to extraction strategies
 * using regex patterns with priority ordering.
 */

import {
  lookupLabel,
  normalizeRole,
  getLabelsForStrategy,
  getLabelsForCategory,
  type ExtractionStrategy,
  type LabelCategory,
  type RegistryMatch,
} from '../../services/mfcLabelRegistry';

describe('MFC Label Registry', () => {
  describe('lookupLabel', () => {
    describe('grouped-entries strategy (companies/artists)', () => {
      it('should match "Companies" as grouped-entries company', () => {
        const result = lookupLabel('Companies');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
        expect(result!.category).toBe('company');
      });

      it('should match "Company" as grouped-entries company', () => {
        const result = lookupLabel('Company');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
        expect(result!.category).toBe('company');
      });

      it('should match "Artists" as grouped-entries artist', () => {
        const result = lookupLabel('Artists');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
        expect(result!.category).toBe('artist');
      });

      it('should match "Artist" as grouped-entries artist', () => {
        const result = lookupLabel('Artist');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
        expect(result!.category).toBe('artist');
      });
    });

    describe('individual-role strategy', () => {
      it('should match "Distributor" as individual-role company', () => {
        const result = lookupLabel('Distributor');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('company');
        expect(result!.role).toBe('Distributor');
      });

      it('should match "Distributors" as individual-role company', () => {
        const result = lookupLabel('Distributors');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('company');
        expect(result!.role).toBe('Distributor');
      });

      it('should match "Retailer" as individual-role company', () => {
        const result = lookupLabel('Retailer');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('company');
        expect(result!.role).toBe('Retailer');
      });

      it('should match "Retailers" as individual-role company', () => {
        const result = lookupLabel('Retailers');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.role).toBe('Retailer');
      });

      it('should match "Publisher" as individual-role company', () => {
        const result = lookupLabel('Publisher');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('company');
        expect(result!.role).toBe('Publisher');
      });

      it('should match "Publishers" as individual-role company', () => {
        const result = lookupLabel('Publishers');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.role).toBe('Publisher');
      });

      it('should match "Sculptor" as individual-role artist', () => {
        const result = lookupLabel('Sculptor');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('artist');
        expect(result!.role).toBe('Sculptor');
      });

      it('should match "Sculptors" as individual-role artist', () => {
        const result = lookupLabel('Sculptors');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.role).toBe('Sculptor');
      });

      it('should match "Illustrator" as individual-role artist', () => {
        const result = lookupLabel('Illustrator');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('artist');
        expect(result!.role).toBe('Illustrator');
      });

      it('should match "Illustrators" as individual-role artist', () => {
        const result = lookupLabel('Illustrators');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.role).toBe('Illustrator');
      });

      it('should match "Original Illustrator" as individual-role artist', () => {
        const result = lookupLabel('Original Illustrator');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('artist');
        expect(result!.role).toBe('Illustrator');
      });

      it('should match "Original Illustrators" as individual-role artist', () => {
        const result = lookupLabel('Original Illustrators');
        expect(result).toBeDefined();
        expect(result!.role).toBe('Illustrator');
      });

      it('should match "Painter" as individual-role artist', () => {
        const result = lookupLabel('Painter');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('artist');
        expect(result!.role).toBe('Painter');
      });

      it('should match "Painters" as individual-role artist', () => {
        const result = lookupLabel('Painters');
        expect(result).toBeDefined();
        expect(result!.role).toBe('Painter');
      });

      it('should match "Designer" as individual-role artist', () => {
        const result = lookupLabel('Designer');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('artist');
        expect(result!.role).toBe('Designer');
      });

      it('should match "Designers" as individual-role artist', () => {
        const result = lookupLabel('Designers');
        expect(result).toBeDefined();
        expect(result!.role).toBe('Designer');
      });

      it('should match "Color" as individual-role artist (Color Producer)', () => {
        const result = lookupLabel('Color');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.category).toBe('artist');
        expect(result!.role).toBe('Color Producer');
      });

      it('should match "Colour" as individual-role artist (Color Producer)', () => {
        const result = lookupLabel('Colour');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
        expect(result!.role).toBe('Color Producer');
      });
    });

    describe('text-field strategy', () => {
      it('should match "Title" as text-field metadata', () => {
        const result = lookupLabel('Title');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Origin" as text-field metadata', () => {
        const result = lookupLabel('Origin');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Version" as text-field metadata', () => {
        const result = lookupLabel('Version');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Classification" as text-field metadata', () => {
        const result = lookupLabel('Classification');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Classifications" (plural) as text-field metadata', () => {
        const result = lookupLabel('Classifications');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Origins" (plural) as text-field metadata', () => {
        const result = lookupLabel('Origins');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
        expect(result!.category).toBe('metadata');
      });
    });

    describe('special-field strategies', () => {
      it('should match "Category" as category-field', () => {
        const result = lookupLabel('Category');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('category-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Materials" as materials-field', () => {
        const result = lookupLabel('Materials');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('materials-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Material" as materials-field', () => {
        const result = lookupLabel('Material');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('materials-field');
      });

      it('should match "Dimensions" as dimensions-field', () => {
        const result = lookupLabel('Dimensions');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('dimensions-field');
        expect(result!.category).toBe('metadata');
      });

      it('should match "Dimension" as dimensions-field', () => {
        const result = lookupLabel('Dimension');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('dimensions-field');
      });

      it('should match "Various" as tags-field', () => {
        const result = lookupLabel('Various');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('tags-field');
        expect(result!.category).toBe('tag');
      });

      it('should match "Releases" as releases-field', () => {
        const result = lookupLabel('Releases');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('releases-field');
        expect(result!.category).toBe('release');
      });

      it('should match "Release" as releases-field', () => {
        const result = lookupLabel('Release');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('releases-field');
      });

      it('should match "Releases View all (+1)Hide" as releases-field', () => {
        const result = lookupLabel('Releases View all (+1)Hide');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('releases-field');
      });

      it('should match "Releases View all (+3)Hide" as releases-field', () => {
        const result = lookupLabel('Releases View all (+3)Hide');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('releases-field');
      });
    });

    describe('skip strategy', () => {
      it('should match "Character" as skip', () => {
        const result = lookupLabel('Character');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('skip');
      });

      it('should match "Characters" as skip', () => {
        const result = lookupLabel('Characters');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('skip');
      });

      it.each([
        'Sold by',
        'Mentioned in', 'Average rating', 'Added by',
        'Last edited by', 'Wishability', 'Hunted by', 'Reviewed by',
        'Top 100', 'Top 50', 'Events', 'Event', 'Shop',
      ])('should match "%s" as skip', (label) => {
        const result = lookupLabel(label);
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('skip');
      });
    });

    describe('community-count-field strategy', () => {
      it.each([
        'Owned by', 'Ordered by', 'Wished by', 'Listed in',
      ])('should match "%s" as community-count-field', (label) => {
        const result = lookupLabel(label);
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('community-count-field');
      });
    });

    describe('community-score-field strategy', () => {
      it('should match "Score" as community-score-field', () => {
        const result = lookupLabel('Score');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('community-score-field');
      });
    });

    describe('case insensitivity', () => {
      it('should match "companies" (lowercase)', () => {
        const result = lookupLabel('companies');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
      });

      it('should match "ARTISTS" (uppercase)', () => {
        const result = lookupLabel('ARTISTS');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
      });

      it('should match "sculptor" (lowercase)', () => {
        const result = lookupLabel('sculptor');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('individual-role');
      });

      it('should match "TITLE" (uppercase)', () => {
        const result = lookupLabel('TITLE');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('text-field');
      });

      it('should match "Materials" (mixed case)', () => {
        const result = lookupLabel('Materials');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('materials-field');
      });
    });

    describe('unknown labels', () => {
      it('should return undefined for unknown labels', () => {
        expect(lookupLabel('FooBar')).toBeUndefined();
      });

      it('should return undefined for empty string', () => {
        expect(lookupLabel('')).toBeUndefined();
      });

      it('should return undefined for whitespace-only', () => {
        expect(lookupLabel('   ')).toBeUndefined();
      });
    });

    describe('priority ordering', () => {
      it('should match grouped "Company" before individual role "Company"', () => {
        // "Company" singular should match grouped-entries (higher priority)
        // because MFC sometimes uses singular "Company" for the grouped field
        const result = lookupLabel('Company');
        expect(result).toBeDefined();
        expect(result!.strategy).toBe('grouped-entries');
      });
    });
  });

  describe('getLabelsForStrategy', () => {
    it('should return all grouped-entries registry entries', () => {
      const entries = getLabelsForStrategy('grouped-entries');
      expect(entries.length).toBeGreaterThanOrEqual(2); // company + artist
    });

    it('should return all individual-role registry entries', () => {
      const entries = getLabelsForStrategy('individual-role');
      expect(entries.length).toBeGreaterThanOrEqual(8); // distributor, retailer, publisher, sculptor, etc.
    });

    it('should return empty array for nonexistent strategy', () => {
      const entries = getLabelsForStrategy('nonexistent' as ExtractionStrategy);
      expect(entries).toEqual([]);
    });
  });

  describe('getLabelsForCategory', () => {
    it('should return all company-related entries', () => {
      const entries = getLabelsForCategory('company');
      expect(entries.length).toBeGreaterThanOrEqual(4); // companies, distributor, retailer, publisher
    });

    it('should return all artist-related entries', () => {
      const entries = getLabelsForCategory('artist');
      expect(entries.length).toBeGreaterThanOrEqual(6); // artists, sculptor, illustrator, orig illustrator, painter, designer, color
    });

    it('should return all metadata entries', () => {
      const entries = getLabelsForCategory('metadata');
      expect(entries.length).toBeGreaterThanOrEqual(7); // title, origin, version, category, classification, materials, dimensions, + skip labels
    });
  });

  describe('normalizeRole', () => {
    it.each([
      ['Color producers', 'Color Producer'],
      ['Color producer', 'Color Producer'],
      ['Colour producers', 'Color Producer'],
      ['Colour', 'Color Producer'],
      ['Color', 'Color Producer'],
      ['Sculptor', 'Sculptor'],
      ['Sculptors', 'Sculptor'],
      ['Illustrator', 'Illustrator'],
      ['Original Illustrator', 'Illustrator'],
      ['Painter', 'Painter'],
      ['Designer', 'Designer'],
      ['Manufacturer', 'Manufacturer'],
      ['Manufacturers', 'Manufacturer'],
      ['Distributor', 'Distributor'],
      ['Retailer', 'Retailer'],
      ['Publisher', 'Publisher'],
      // Audit-discovered roles
      ['Char. designer', 'Character Designer'],
      ['Char. designers', 'Character Designer'],
      ['Character designer', 'Character Designer'],
      ['Ori. creator', 'Original Creator'],
      ['Ori. creators', 'Original Creator'],
      ['Original creator', 'Original Creator'],
      ['Producer', 'Producer'],
      ['Producers', 'Producer'],
      ['Label', 'Label'],
      ['Labels', 'Label'],
      ['Circle', 'Circle'],
      ['Circles', 'Circle'],
      ['Cooperation', 'Cooperation'],
      ['Cooperations', 'Cooperation'],
      ['Director', 'Director'],
      ['Directors', 'Director'],
      ['Photographer', 'Photographer'],
      ['Photographers', 'Photographer'],
      ['Planning', 'Planning'],
      ['Plannings', 'Planning'],
      ['Mangaka', 'Mangaka'],
      ['Mangakas', 'Mangaka'],
    ])('should normalize "%s" to "%s"', (raw, expected) => {
      expect(normalizeRole(raw)).toBe(expected);
    });

    it('should return unknown roles as-is', () => {
      expect(normalizeRole('Some Unknown Role')).toBe('Some Unknown Role');
    });

    it('should handle empty string', () => {
      expect(normalizeRole('')).toBe('');
    });
  });
});
