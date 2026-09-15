/**
 * Type-test fixture: image PROVENANCE on `ImageRef` (contract 0.12.0) — the optional `sourceClass`
 * and `contentLevel` fields plus the `SourceClass` / `ContentLevel` exports. RED before the 0.12.0
 * bump (neither field exists on `ImageRef` ⇒ excess-property errors, and neither type is exported);
 * GREEN after.
 *
 * The two fields carry the ingest-contract 0.6.0 vocabulary onto the wire: `sourceClass` says WHO
 * published the plate (manufacturer press vs. a retailer's own studio), and `contentLevel` says how
 * an item is content-rated. Both are OPTIONAL and ADDITIVE — the three original fields stay
 * required, so `describe-images.ts`'s `minimal` ref keeps compiling — because most stores can prove
 * neither, and a ruleset fills only what it can prove. `existing-two-arg-ruleset.ts` remains the
 * guard that a ruleset declaring nothing still compiles.
 */
import type { ImageRef, SourceClass, ContentLevel } from '../src/index';

// The provenance-bearing ref: the three originals PLUS both new fields.
const withProvenance: ImageRef = {
  url: 'https://cdn.example.test/main/a.jpg',
  role: 'gallery',
  position: 0,
  sourceClass: 'manufacturer_press',
  contentLevel: 'explicit',
};

// Additive guard: a ref with NEITHER new field still satisfies ImageRef.
const withoutProvenance: ImageRef = { url: 'https://cdn.example.test/a.jpg', role: 'gallery', position: 1 };

// Either field may stand alone — amiami proves sourceClass with no level, mfc the reverse.
const sourceClassOnly: ImageRef = { url: 'https://cdn.example.test/b.jpg', role: 'other', position: 2, sourceClass: 'retailer_studio' };
const contentLevelOnly: ImageRef = { url: 'https://cdn.example.test/c.jpg', role: 'gallery', position: 3, contentLevel: 'unknown' };

// The full closed vocabularies the ingest contract defines.
const everySourceClass: SourceClass[] = ['manufacturer_press', 'retailer_studio', 'user_photo', 'unknown'];
const everyContentLevel: ContentLevel[] = ['general', 'intermediate', 'explicit', 'controversial', 'nsfw', 'nsfw+', 'unknown'];

const rejectsUnknownSourceClass: ImageRef = {
  url: 'https://cdn.example.test/a.jpg',
  role: 'gallery',
  position: 0,
  // @ts-expect-error — sourceClass is the closed ingest-contract union
  sourceClass: 'wholesaler',
};

const rejectsUnknownContentLevel: ImageRef = {
  url: 'https://cdn.example.test/a.jpg',
  role: 'gallery',
  position: 0,
  // @ts-expect-error — contentLevel is the closed ingest-contract union
  contentLevel: 'adult',
};

void withProvenance;
void withoutProvenance;
void sourceClassOnly;
void contentLevelOnly;
void everySourceClass;
void everyContentLevel;
void rejectsUnknownSourceClass;
void rejectsUnknownContentLevel;
