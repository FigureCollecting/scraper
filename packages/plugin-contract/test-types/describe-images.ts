/**
 * Type-test fixture: the IMAGE DESCRIPTION hook (contract 0.10.0) — `ExtractionRuleset.describeImages`
 * and the `ImageRef` / `ImageRole` exports. RED before the 0.10.0 bump (`describeImages` does not
 * exist ⇒ an excess-property error, and neither type has an export); GREEN after.
 *
 * The point of the hook is the SEPARATION it encodes: a ruleset knows its own store's field shapes
 * and what each one MEANS (a gallery plate, a list thumbnail, a user upload), and the engine knows
 * none of that. So the store-specific part stays private and the engine consumes one normalized,
 * store-agnostic list. `existing-two-arg-ruleset.ts` remains the guard that a ruleset WITHOUT the
 * new hook still compiles.
 */
import type {
  ExtractionRuleset,
  ExtractedData,
  ImageRef,
  ImageRole,
  ValidationResult,
} from '../src/index';

// The minimal ref: every field is required — a url with no role is not describable, and a list with
// no positions cannot be ordered.
const minimal: ImageRef = { url: 'https://cdn.example.test/a.jpg', role: 'gallery', position: 0 };

const everyRole: ImageRole[] = ['gallery', 'thumbnail', 'user', 'other'];

const rejectsUnknownRole: ImageRef = {
  url: 'https://cdn.example.test/a.jpg',
  // @ts-expect-error — the role vocabulary is closed: the engine's capture rule keys on it
  role: 'hero',
  position: 0,
};

const rejectsMissingPosition = {
  url: 'https://cdn.example.test/a.jpg',
  role: 'gallery' as const,
  // @ts-expect-error — `position` is required: it is the asset's index on the referencing page
} satisfies ImageRef;

const ruleset: ExtractionRuleset = {
  siteId: 'examplestore',
  version: '1.0',
  extract(html: string, url: string): ExtractedData {
    return {
      source: { site: 'examplestore', itemId: '1', extractedAt: new Date().toISOString() },
      fields: { html, url },
      warnings: [],
    };
  },
  validate(_data: ExtractedData): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  },
  // The store's OWN field names never leave the ruleset — the engine is handed refs, not fields.
  describeImages(fields: Record<string, unknown>): ImageRef[] {
    const plates = Array.isArray(fields.somePrivateFieldName) ? (fields.somePrivateFieldName as string[]) : [];
    return plates.map((url, position) => ({ url, role: 'gallery', position }));
  },
};

// The hook is SYNCHRONOUS by construction: it reads already-extracted fields and fetches nothing.
const rejectsAsync: ExtractionRuleset = {
  ...ruleset,
  // @ts-expect-error — describeImages returns ImageRef[], never a promise: it does no I/O
  async describeImages(): Promise<ImageRef[]> {
    return [];
  },
};

void minimal;
void everyRole;
void rejectsUnknownRole;
void rejectsMissingPosition;
void ruleset;
void rejectsAsync;
