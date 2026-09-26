/**
 * Type-test fixture: ROTATING SEED LISTS (contract 0.16.0) — `RetrievalCapability.rotatingSeedLists`
 * and the `RotatingSeedList` export. RED before the 0.16.0 bump (the field is an excess property and
 * `RotatingSeedList` has no export); GREEN after. `seed-lists.ts` remains the guard that the
 * `seedLists` field is untouched: the two fields are separate so an engine that predates this one
 * never sees the rotating lists at all.
 */
import type { RotatingSeedList, SeedList, StoreCapabilities } from '../src/index';

const store: StoreCapabilities = {
  siteId: 'examplestore',
  name: 'Example Store',
  domains: ['example.test'],
  rateLimit: {
    domain: 'example.test',
    baseDelayMs: 3000,
    minDelayMs: 1500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    recoveryDivisor: 2,
    successThreshold: 3,
  },
  requiresBrowser: false,
  allowedCookies: [],
  retrieval: {
    byId: { urlTemplate: 'https://example.test/item/{id}', idKind: 'store-internal' },
    seedLists: [{ id: 'new-arrivals', url: 'https://example.test/new', cadence: 'daily' }],
    rotatingSeedLists: [
      { id: 'maker-1-d9', url: 'https://example.test/search?maker=1&role=9', group: 'maker-1', order: 1 },
      { id: 'maker-1-d1', url: 'https://example.test/search?maker=1&role=1', group: 'maker-1', order: 1 },
      { id: 'maker-2-d9', url: 'https://example.test/search?maker=2&role=9', group: 'maker-2', order: 2 },
    ],
  },
};

// The whole entry: id + url + group + order, all required.
const minimal: RotatingSeedList = { id: 'a', url: 'https://example.test/a', group: 'g', order: 1 };

const rejectsMissingGroup: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `group` is required: the group is the unit the rotation schedules
  rotatingSeedLists: [{ id: 'a', url: 'https://example.test/a', order: 1 }],
};

const rejectsMissingOrder: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `order` is required: it is the group's place in the rotation
  rotatingSeedLists: [{ id: 'a', url: 'https://example.test/a', group: 'g' }],
};

const rejectsStringOrder: NonNullable<StoreCapabilities['retrieval']> = {
  // @ts-expect-error — `order` is a number
  rotatingSeedLists: [{ id: 'a', url: 'https://example.test/a', group: 'g', order: '1' }],
};

// A rotating list is NOT a seed list: it carries no cadence (the engine's rotation owns the timing).
// @ts-expect-error — `cadence` is not part of a rotating list
const rejectsCadence: RotatingSeedList = { id: 'a', url: 'https://example.test/a', group: 'g', order: 1, cadence: 'weekly' };

// …and a seed list without a cadence is still refused: the old field is unchanged.
// @ts-expect-error — `cadence` stays required on `seedLists`
const seedStillNeedsCadence: SeedList = { id: 'a', url: 'https://example.test/a' };

void store;
void minimal;
void rejectsMissingGroup;
void rejectsMissingOrder;
void rejectsStringOrder;
void rejectsCadence;
void seedStillNeedsCadence;
