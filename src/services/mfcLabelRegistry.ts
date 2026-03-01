/**
 * MFC Label Registry - Central regex pattern registry for MFC HTML data-field labels
 *
 * Maps MFC page labels (e.g., "Companies", "Sculptor", "Materials") to extraction
 * strategies. Uses regex patterns for resilience against label variations
 * (singular/plural, case differences).
 *
 * Priority ordering ensures grouped labels are checked before individual roles
 * when there's ambiguity (e.g., "Company" as grouped vs individual).
 */

export type ExtractionStrategy =
  | 'grouped-entries'    // Companies/Artists: .item-entries with role sub-elements
  | 'individual-role'    // Individual role label: label IS the role
  | 'text-field'         // Simple text (Title, Origin, Version, Classification)
  | 'category-field'     // Category: span[class^="item-category"]
  | 'materials-field'    // Materials: multiple linked entries joined by comma
  | 'dimensions-field'   // Dimensions: scale + height sub-elements
  | 'tags-field'         // Various: extract <a> texts as tag array
  | 'releases-field'     // Releases: complex date/price extraction
  | 'community-count-field'  // Community counts: owned by, ordered by, etc.
  | 'community-score-field'  // Community score: average public score (1-10)
  | 'skip';              // Known label handled elsewhere (e.g., Character)

export type LabelCategory = 'company' | 'artist' | 'metadata' | 'tag' | 'release';

export interface RegistryEntry {
  pattern: RegExp;
  strategy: ExtractionStrategy;
  category: LabelCategory;
  role?: string;  // For individual-role: the standardized role name
}

export interface RegistryMatch {
  strategy: ExtractionStrategy;
  category: LabelCategory;
  role?: string;
}

/**
 * Registry entries in priority order.
 * Grouped labels come before individual roles to handle ambiguity
 * (e.g., "Company" singular matches grouped-entries, not individual-role).
 */
const LABEL_REGISTRY: RegistryEntry[] = [
  // === GROUPED ENTRIES (highest priority) ===
  // Must come before individual roles so "Company"/"Artist" singular match here
  { pattern: /^compan(?:y|ies)$/i, strategy: 'grouped-entries', category: 'company' },
  { pattern: /^artists?$/i, strategy: 'grouped-entries', category: 'artist' },

  // === INDIVIDUAL ROLE LABELS (company) ===
  { pattern: /^distribut(?:or|ors?)$/i, strategy: 'individual-role', category: 'company', role: 'Distributor' },
  { pattern: /^retail(?:er|ers?)$/i, strategy: 'individual-role', category: 'company', role: 'Retailer' },
  { pattern: /^publish(?:er|ers?)$/i, strategy: 'individual-role', category: 'company', role: 'Publisher' },

  // === INDIVIDUAL ROLE LABELS (artist) ===
  // "Original Illustrator" must come before "Illustrator" for correct matching
  { pattern: /^original\s+illustrat(?:or|ors?)$/i, strategy: 'individual-role', category: 'artist', role: 'Illustrator' },
  { pattern: /^sculpt(?:or|ors?)$/i, strategy: 'individual-role', category: 'artist', role: 'Sculptor' },
  { pattern: /^illustrat(?:or|ors?)$/i, strategy: 'individual-role', category: 'artist', role: 'Illustrator' },
  { pattern: /^paint(?:er|ers?)$/i, strategy: 'individual-role', category: 'artist', role: 'Painter' },
  { pattern: /^design(?:er|ers?)$/i, strategy: 'individual-role', category: 'artist', role: 'Designer' },
  { pattern: /^colou?r(?:\s+producers?)?$/i, strategy: 'individual-role', category: 'artist', role: 'Color Producer' },

  // === TEXT FIELDS (metadata) ===
  { pattern: /^title$/i, strategy: 'text-field', category: 'metadata' },
  { pattern: /^origins?$/i, strategy: 'text-field', category: 'metadata' },
  { pattern: /^version$/i, strategy: 'text-field', category: 'metadata' },
  { pattern: /^classifications?$/i, strategy: 'text-field', category: 'metadata' },

  // === SPECIAL FIELD STRATEGIES (metadata) ===
  { pattern: /^category$/i, strategy: 'category-field', category: 'metadata' },
  { pattern: /^materials?$/i, strategy: 'materials-field', category: 'metadata' },
  { pattern: /^dimensions?$/i, strategy: 'dimensions-field', category: 'metadata' },

  // === TAGS ===
  { pattern: /^various$/i, strategy: 'tags-field', category: 'tag' },

  // === RELEASES ===
  // Matches "Release", "Releases", and "Releases View all (+N)Hide" (expanded view label)
  { pattern: /^releases?(?:\s+view\s+all\s+\(\+\d+\)hide)?$/i, strategy: 'releases-field', category: 'release' },

  // === SKIP (handled elsewhere or not relevant to figure data) ===
  { pattern: /^characters?$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^score$/i, strategy: 'community-score-field', category: 'metadata' },
  { pattern: /^owned\s+by$/i, strategy: 'community-count-field', category: 'metadata' },
  { pattern: /^ordered\s+by$/i, strategy: 'community-count-field', category: 'metadata' },
  { pattern: /^sold\s+by$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^wished\s+by$/i, strategy: 'community-count-field', category: 'metadata' },
  { pattern: /^mentioned\s+in$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^listed\s+in$/i, strategy: 'community-count-field', category: 'metadata' },
  { pattern: /^average\s+rating$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^added\s+by$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^last\s+edited\s+by$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^wishability$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^hunted\s+by$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^reviewed\s+by$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^top\s+\d+$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^events?$/i, strategy: 'skip', category: 'metadata' },
  { pattern: /^shops?$/i, strategy: 'skip', category: 'metadata' },
];

/**
 * Look up an MFC data-field label in the registry.
 * Returns the matching strategy/category/role, or undefined if unknown.
 */
export function lookupLabel(label: string): RegistryMatch | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;

  for (const entry of LABEL_REGISTRY) {
    if (entry.pattern.test(trimmed)) {
      const match: RegistryMatch = {
        strategy: entry.strategy,
        category: entry.category,
      };
      if (entry.role) {
        match.role = entry.role;
      }
      return match;
    }
  }

  return undefined;
}

/**
 * Normalize a role string from MFC grouped entry HTML.
 * MFC uses varied role text in <em> sub-elements (e.g., "Color producers",
 * "Sculptors"). This maps them to canonical role names.
 */
const ROLE_NORMALIZATION: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /^sculpt(?:or|ors?)$/i, canonical: 'Sculptor' },
  { pattern: /^illustrat(?:or|ors?)$/i, canonical: 'Illustrator' },
  { pattern: /^original\s+illustrat(?:or|ors?)$/i, canonical: 'Illustrator' },
  { pattern: /^paint(?:er|ers?)$/i, canonical: 'Painter' },
  { pattern: /^colou?r(?:\s+producers?)?$/i, canonical: 'Color Producer' },
  { pattern: /^design(?:er|ers?)$/i, canonical: 'Designer' },
  { pattern: /^char(?:\.|acter)?\s+designers?$/i, canonical: 'Character Designer' },
  { pattern: /^ori(?:\.|ginal)?\s+creators?$/i, canonical: 'Original Creator' },
  { pattern: /^manufactur(?:er|ers?)$/i, canonical: 'Manufacturer' },
  { pattern: /^distribut(?:or|ors?)$/i, canonical: 'Distributor' },
  { pattern: /^retail(?:er|ers?)$/i, canonical: 'Retailer' },
  { pattern: /^publish(?:er|ers?)$/i, canonical: 'Publisher' },
  { pattern: /^producers?$/i, canonical: 'Producer' },
  { pattern: /^labels?$/i, canonical: 'Label' },
  { pattern: /^circles?$/i, canonical: 'Circle' },
  { pattern: /^cooperations?$/i, canonical: 'Cooperation' },
  { pattern: /^directors?$/i, canonical: 'Director' },
  { pattern: /^photographers?$/i, canonical: 'Photographer' },
  { pattern: /^plannings?$/i, canonical: 'Planning' },
  { pattern: /^mangakas?$/i, canonical: 'Mangaka' },
];

export function normalizeRole(rawRole: string): string {
  const trimmed = rawRole.trim();
  if (!trimmed) return trimmed;

  for (const entry of ROLE_NORMALIZATION) {
    if (entry.pattern.test(trimmed)) {
      return entry.canonical;
    }
  }

  return trimmed;  // Return as-is if no match (preserve unknown roles)
}

/**
 * Get all registry entries matching a given extraction strategy.
 */
export function getLabelsForStrategy(strategy: ExtractionStrategy): RegistryEntry[] {
  return LABEL_REGISTRY.filter(entry => entry.strategy === strategy);
}

/**
 * Get all registry entries matching a given category.
 */
export function getLabelsForCategory(category: LabelCategory): RegistryEntry[] {
  return LABEL_REGISTRY.filter(entry => entry.category === category);
}
