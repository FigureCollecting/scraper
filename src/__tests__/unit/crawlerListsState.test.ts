/**
 * Lists-state stores: `<dir>/<siteId>.lists.json`, never a section of `<siteId>.json` — the ledger loader
 * drops unknown sections (an older engine would erase it) and the seed Job also writes the ledger.
 */
import * as path from 'path';
import {
  createFileListsStateStore,
  createMemoryListsStateStore,
  createEmptyListsState,
  setListsGroup,
  LISTS_STATE_VERSION,
  type ListsState,
} from '../../crawler/listsState';
import { createFileLedgerStore, LEDGER_VERSION, type FsLike } from '../../crawler/ledger';

const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

const makeFakeFs = () => {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let failRead: Error | undefined;
  const fs: FsLike = {
    async readFile(p) {
      calls.push(`read ${p}`);
      if (failRead) throw failRead;
      const c = files.get(p);
      if (c === undefined) throw enoent(p);
      return c;
    },
    async writeFile(p, data) {
      calls.push(`write ${p}`);
      files.set(p, data);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    async mkdir(p) {
      calls.push(`mkdir ${p}`);
      return undefined;
    },
  };
  return { fs, files, calls, failRead: (e: Error) => (failRead = e) };
};

const DIR = '/ledgers';
const FILE = path.join(DIR, 'mfc.lists.json');

const sample = (): ListsState => ({
  version: LISTS_STATE_VERSION,
  siteId: 'mfc',
  groups: {
    'company-7620': {
      lastAttemptAt: '2026-09-26T16:00:00.000Z',
      lastTriedAt: '2026-09-26T16:00:00.000Z',
      outcome: 'ok',
      seen: 200,
      new: 123,
      enqueued: 50,
      strikes: 0,
      retries: 0,
    },
    'company-7619': {
      lastTriedAt: '2026-09-26T17:00:00.000Z',
      outcome: 'transient',
      reason: 'socket hang up',
      seen: 100,
      new: 40,
      enqueued: 0,
      strikes: 1,
      retries: 1,
      answered: { 'company-7619-d9': 'ok', 'company-7619-d3': 'failed' },
      seenIds: ['98665', '98666'],
    },
    'company-7621': {
      lastTriedAt: '2026-09-26T18:00:00.000Z',
      outcome: 'blocked',
      reason: 'challenge page',
      seen: 0,
      new: 0,
      enqueued: 0,
      strikes: 1,
      blockedStrikes: 1,
      retries: 0,
      answered: {},
    },
    'company-7622': {
      lastAttemptAt: '2026-09-20T16:00:00.000Z',
      lastTriedAt: '2026-09-20T16:00:00.000Z',
      outcome: 'blocked',
      reason: 'store answered 403',
      seen: 0,
      new: 0,
      enqueued: 0,
      strikes: 3,
      retries: 0,
      spentBlocked: true,
    },
    'company-7633': { lastTriedAt: '2026-09-26T19:00:00.000Z', outcome: 'interrupted', seen: 0, new: 0, enqueued: 0, strikes: 0, retries: 0, answered: {} },
  },
  pending: [{ itemId: '98665', collectUrl: 'https://myfigurecollection.net/item/98665', group: 'company-7620' }],
  pausedUntil: '2026-09-27T18:00:00.000Z',
  updatedAt: '2026-09-26T16:00:10.000Z',
});

describe('lists-state file store', () => {
  it('a missing file is a fresh, empty state', async () => {
    const { fs } = makeFakeFs();
    expect(await createFileListsStateStore(DIR, fs).load('mfc')).toEqual(createEmptyListsState('mfc'));
    expect(createEmptyListsState('mfc')).toEqual({ version: 1, siteId: 'mfc', groups: {}, pending: [] });
  });

  it('round-trips through <siteId>.lists.json, written atomically (tmp file, then rename)', async () => {
    const fake = makeFakeFs();
    const store = createFileListsStateStore(DIR, fake.fs, 42);
    await store.save(sample());
    expect(fake.calls).toEqual([`mkdir ${DIR}`, `write ${FILE}.tmp-42`, `rename ${FILE}.tmp-42 -> ${FILE}`]);
    expect(await store.load('mfc')).toEqual(sample());
  });

  it('anything unreadable, of another version or store, or structurally wrong is corrupt', async () => {
    const cases: unknown[] = [
      '{not json',
      { ...sample(), version: 2 },
      { ...sample(), siteId: 'hpoi' },
      { ...sample(), groups: [] },
      { ...sample(), groups: { g: null } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], outcome: 'maybe' } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], seen: -1 } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], lastTriedAt: 5 } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], lastAttemptAt: 5 } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], reason: 5 } } },
      // A timestamp that does not parse would make its group due on every pass: refused, not guessed.
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], lastAttemptAt: 'yesterday' } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], lastTriedAt: 'x' } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], answered: [] } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], answered: { a: 'maybe' } } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], blockedStrikes: -1 } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], blockedStrikes: '1' } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], spentBlocked: 'yes' } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], seenIds: '98665' } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], seenIds: [''] } } },
      { ...sample(), groups: { g: { ...sample().groups['company-7620'], seenIds: [98665] } } },
      { ...sample(), pausedUntil: 'soon' },
      { ...sample(), pausedUntil: 5 },
      { ...sample(), pending: {} },
      { ...sample(), pending: [{ itemId: '', collectUrl: 'https://x.test/1', group: 'g' }] },
      { ...sample(), pending: [{ itemId: '1', collectUrl: 5, group: 'g' }] },
      { ...sample(), pending: [{ itemId: '1', collectUrl: 'https://x.test/1' }] },
      { ...sample(), updatedAt: 5 },
      [],
    ];
    for (const doc of cases) {
      const fake = makeFakeFs();
      fake.files.set(FILE, typeof doc === 'string' ? doc : JSON.stringify(doc));
      expect(await createFileListsStateStore(DIR, fake.fs).load('mfc')).toBe('corrupt');
    }
  });

  it('setListsGroup writes an OWN key, even one named __proto__: the prototype is untouched and the group persists', () => {
    const state = createEmptyListsState('mfc');
    const g = sample().groups['company-7620'];
    setListsGroup(state, '__proto__', g);
    setListsGroup(state, 'constructor', g);
    setListsGroup(state, 'constructor', { ...g, seen: 1 });
    expect(Object.getPrototypeOf(state.groups)).toBe(Object.prototype);
    expect(Object.keys(state.groups)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(state.groups, '__proto__')?.value).toBe(g);
    expect(state.groups['constructor'].seen).toBe(1);
    expect(Object.keys(JSON.parse(JSON.stringify(state)).groups)).toEqual(['__proto__', 'constructor']);
  });

  it('refuses an unsafe siteId (it is a file stem) and lets a non-ENOENT read error propagate', async () => {
    const fake = makeFakeFs();
    const store = createFileListsStateStore(DIR, fake.fs);
    await expect(store.load('../etc')).rejects.toThrow(/unsafe siteId/);
    await expect(store.save({ ...sample(), siteId: 'a/b' })).rejects.toThrow(/unsafe siteId/);
    fake.failRead(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(store.load('mfc')).rejects.toThrow('EACCES');
  });

  it('WHY its own file: a ledger load → save drops unknown top-level sections and never opens the lists file', async () => {
    const fake = makeFakeFs();
    const ledgerFile = path.join(DIR, 'mfc.json');
    fake.files.set(FILE, JSON.stringify(sample()));
    fake.files.set(
      ledgerFile,
      JSON.stringify({ version: LEDGER_VERSION, siteId: 'mfc', enqueued: {}, backfill: { cursor: null }, recent: {}, listsRotation: { any: 1 } }),
    );
    const ledgers = createFileLedgerStore(DIR, fake.fs, 7);
    const loaded = await ledgers.load('mfc');
    if (loaded === 'corrupt') throw new Error('unexpected corrupt ledger');
    await ledgers.save(loaded);
    expect(JSON.parse(fake.files.get(ledgerFile) as string)).not.toHaveProperty('listsRotation');
    expect(fake.calls.some((c) => c.includes('mfc.lists.json'))).toBe(false);
    expect(JSON.parse(fake.files.get(FILE) as string)).toEqual(sample());
  });
});

describe('lists-state memory store', () => {
  it('returns deep copies, a fresh state when absent, and corrupt when seeded so', async () => {
    const store = createMemoryListsStateStore({ mfc: sample(), bad: 'corrupt' });
    const a = await store.load('mfc');
    if (a === 'corrupt') throw new Error('unexpected');
    a.pending.length = 0;
    expect((await store.load('mfc')) as ListsState).toEqual(sample());
    expect(await store.load('bad')).toBe('corrupt');
    expect(await store.load('new')).toEqual(createEmptyListsState('new'));
    await store.save({ ...sample(), pending: [] });
    expect(store.files.get('mfc')?.pending).toEqual([]);
    expect(store.saveLog).toEqual(['mfc']);
  });
});
