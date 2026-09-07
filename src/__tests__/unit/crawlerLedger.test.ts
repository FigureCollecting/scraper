/**
 * Ledger stores — the crawler's durable per-store state. The FILE store persists
 * `<dir>/<siteId>.json` atomically (write `<siteId>.json.tmp-<pid>`, then rename)
 * through an injectable fs; a missing file is a fresh ledger, and anything
 * unreadable / wrong-version / wrong-store is 'corrupt' (the crawler refuses the
 * store and never overwrites the file). The MEMORY store is the test double.
 */
import * as path from 'path';
import * as os from 'os';
import { promises as realFs } from 'fs';
import {
  createEmptyLedger,
  createFileLedgerStore,
  createMemoryLedgerStore,
  LEDGER_VERSION,
  type FsLike,
  type Ledger,
} from '../../crawler/ledger';

const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: no such file, ${p}`), { code: 'ENOENT' });

const makeFakeFs = () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: string[] = [];
  let failWrite: Error | undefined;
  let failRename: Error | undefined;
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
      if (failWrite) throw failWrite;
      if (!dirs.has(path.dirname(p))) throw enoent(path.dirname(p));
      files.set(p, data);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      if (failRename) throw failRename;
      const c = files.get(from);
      if (c === undefined) throw enoent(from);
      files.delete(from);
      files.set(to, c);
    },
    async mkdir(p, opts) {
      calls.push(`mkdir ${p} recursive=${String(opts.recursive)}`);
      dirs.add(p);
      return undefined;
    },
  };
  return {
    fs,
    files,
    dirs,
    calls,
    failWrite: (e: Error | undefined) => (failWrite = e),
    failRename: (e: Error | undefined) => (failRename = e),
    failRead: (e: Error | undefined) => (failRead = e),
  };
};

const sample = (siteId = 'orzgk'): Ledger => ({
  version: LEDGER_VERSION,
  siteId,
  enqueued: { '11': { at: '2026-09-01T00:00:00.000Z', collectUrl: 'https://orzgk.test/api/11' } },
  backfill: { cursor: 7, updatedAt: '2026-09-01T00:00:00.000Z' },
  recent: { lastRunAt: '2026-09-01T00:00:00.000Z', lastNewCount: 1 },
  updatedAt: '2026-09-01T00:00:00.000Z',
});

describe('createEmptyLedger', () => {
  it('builds a fresh v1 ledger for the store with no cursor and nothing enqueued', () => {
    expect(createEmptyLedger('orzgk')).toEqual({
      version: 1,
      siteId: 'orzgk',
      enqueued: {},
      backfill: { cursor: null },
      recent: {},
    });
    expect(LEDGER_VERSION).toBe(1);
  });
});

describe('createFileLedgerStore', () => {
  const DIR = '/var/lib/ingest-crawler';

  describe('load', () => {
    it('returns a fresh empty ledger when the file is missing (ENOENT)', async () => {
      const f = makeFakeFs();
      const store = createFileLedgerStore(DIR, f.fs);
      const l = await store.load('orzgk');
      expect(l).toEqual(createEmptyLedger('orzgk'));
      expect(f.calls).toEqual([`read ${path.join(DIR, 'orzgk.json')}`]);
    });

    it('round-trips a valid ledger file', async () => {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(sample()));
      const store = createFileLedgerStore(DIR, f.fs);
      expect(await store.load('orzgk')).toEqual(sample());
    });

    it('normalizes missing optional sections (recent / backfill) on a minimal valid file', async () => {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify({ version: 1, siteId: 'orzgk', enqueued: {} }));
      const store = createFileLedgerStore(DIR, f.fs);
      expect(await store.load('orzgk')).toEqual({ version: 1, siteId: 'orzgk', enqueued: {}, backfill: { cursor: null }, recent: {} });
    });

    it("returns 'corrupt' on unparseable JSON", async () => {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), '{"version":1,"siteId":"orzgk",');
      expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toBe('corrupt');
    });

    it("returns 'corrupt' on a wrong version", async () => {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify({ ...sample(), version: 2 }));
      expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toBe('corrupt');
    });

    it("returns 'corrupt' when the file belongs to another store", async () => {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(sample('goodsmileus')));
      expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toBe('corrupt');
    });

    it("returns 'corrupt' on a non-object document or a malformed section", async () => {
      const cases: unknown[] = [
        null,
        [],
        'str',
        42,
        { ...sample(), enqueued: [] },
        { ...sample(), enqueued: 'x' },
        { ...sample(), enqueued: null },
        { ...sample(), backfill: 'x' },
        { ...sample(), backfill: { cursor: '7' } },
        { ...sample(), backfill: { cursor: 0 } },
        { ...sample(), backfill: { cursor: 1.5 } },
        { ...sample(), recent: 3 },
      ];
      for (const doc of cases) {
        const f = makeFakeFs();
        f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(doc));
        expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toBe('corrupt');
      }
    });

    it('propagates a non-ENOENT read failure (permissions) instead of masking it as fresh', async () => {
      const f = makeFakeFs();
      f.failRead(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      await expect(createFileLedgerStore(DIR, f.fs).load('orzgk')).rejects.toThrow('EACCES');
    });

    it('rejects a siteId that is not a safe file stem (no path traversal) without touching the fs', async () => {
      const f = makeFakeFs();
      const store = createFileLedgerStore(DIR, f.fs);
      await expect(store.load('../etc/passwd')).rejects.toThrow(/siteId/);
      await expect(store.load('')).rejects.toThrow(/siteId/);
      await expect(store.load('a/b')).rejects.toThrow(/siteId/);
      expect(f.calls).toEqual([]);
    });
  });

  describe('save', () => {
    it('creates the directory, writes <siteId>.json.tmp-<pid>, then renames over <siteId>.json', async () => {
      const f = makeFakeFs();
      const store = createFileLedgerStore(DIR, f.fs, 4242);
      await store.save(sample());
      const final = path.join(DIR, 'orzgk.json');
      const tmp = path.join(DIR, 'orzgk.json.tmp-4242');
      expect(f.calls).toEqual([`mkdir ${DIR} recursive=true`, `write ${tmp}`, `rename ${tmp} -> ${final}`]);
      expect([...f.files.keys()]).toEqual([final]); // tmp file gone, only the final remains
      expect(JSON.parse(f.files.get(final)!)).toEqual(sample());
    });

    it('defaults the tmp suffix to the current process pid', async () => {
      const f = makeFakeFs();
      await createFileLedgerStore(DIR, f.fs).save(sample());
      expect(f.calls[1]).toBe(`write ${path.join(DIR, `orzgk.json.tmp-${process.pid}`)}`);
    });

    it('writes a stable, human-readable (pretty-printed) document that loads back identically', async () => {
      const f = makeFakeFs();
      const store = createFileLedgerStore(DIR, f.fs);
      await store.save(sample());
      const raw = f.files.get(path.join(DIR, 'orzgk.json'))!;
      expect(raw).toContain('\n  "version": 1');
      expect(await store.load('orzgk')).toEqual(sample());
    });

    it('leaves the existing file untouched when the tmp write fails (atomicity)', async () => {
      const f = makeFakeFs();
      const final = path.join(DIR, 'orzgk.json');
      f.dirs.add(DIR);
      f.files.set(final, 'OLD');
      f.failWrite(new Error('ENOSPC'));
      await expect(createFileLedgerStore(DIR, f.fs).save(sample())).rejects.toThrow('ENOSPC');
      expect(f.files.get(final)).toBe('OLD');
      expect(f.calls.some((c) => c.startsWith('rename'))).toBe(false);
    });

    it('leaves the existing file untouched when the rename fails', async () => {
      const f = makeFakeFs();
      const final = path.join(DIR, 'orzgk.json');
      f.dirs.add(DIR);
      f.files.set(final, 'OLD');
      f.failRename(new Error('EXDEV'));
      await expect(createFileLedgerStore(DIR, f.fs).save(sample())).rejects.toThrow('EXDEV');
      expect(f.files.get(final)).toBe('OLD');
    });

    it('rejects an unsafe siteId without touching the fs', async () => {
      const f = makeFakeFs();
      await expect(createFileLedgerStore(DIR, f.fs).save(sample('../x'))).rejects.toThrow(/siteId/);
      expect(f.calls).toEqual([]);
    });
  });

  describe('with the real filesystem (default fs)', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'crawler-ledger-'));
    });
    afterAll(async () => {
      await realFs.rm(dir, { recursive: true, force: true });
    });

    it('persists and reloads a ledger in a nested directory it creates itself', async () => {
      const nested = path.join(dir, 'a', 'b');
      const store = createFileLedgerStore(nested);
      expect(await store.load('orzgk')).toEqual(createEmptyLedger('orzgk'));
      await store.save(sample());
      expect(await store.load('orzgk')).toEqual(sample());
      const names = await realFs.readdir(nested);
      expect(names).toEqual(['orzgk.json']); // no tmp file left behind
    });
  });
});

describe('createMemoryLedgerStore', () => {
  it('starts every store fresh and records saves per siteId', async () => {
    const store = createMemoryLedgerStore();
    expect(await store.load('orzgk')).toEqual(createEmptyLedger('orzgk'));
    await store.save(sample());
    expect(store.saveLog).toEqual(['orzgk']);
    expect(store.files.get('orzgk')).toEqual(sample());
  });

  it('isolates the saved copy from the caller (deep clone on save and on load)', async () => {
    const store = createMemoryLedgerStore();
    const l = sample();
    await store.save(l);
    l.backfill.cursor = 99;
    expect(store.files.get('orzgk')!.backfill.cursor).toBe(7);
    const loaded = (await store.load('orzgk')) as Ledger;
    loaded.backfill.cursor = 100;
    expect(store.files.get('orzgk')!.backfill.cursor).toBe(7);
  });

  it("serves a seeded ledger and a seeded 'corrupt' marker", async () => {
    const store = createMemoryLedgerStore({ orzgk: sample(), goodsmileus: 'corrupt' });
    expect(await store.load('orzgk')).toEqual(sample());
    expect(await store.load('goodsmileus')).toBe('corrupt');
    expect(await store.load('fnc')).toEqual(createEmptyLedger('fnc'));
  });
});

describe('the optional id-range section', () => {
  const DIR = '/var/lib/ingest-crawler';
  const withRange = (range: unknown): Record<string, unknown> => ({ ...sample(), range });

  it('is absent on a fresh ledger and on a file that never had one (an older ledger stays valid)', async () => {
    expect(createEmptyLedger('mfc').range).toBeUndefined();
    const f = makeFakeFs();
    f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(sample()));
    const loaded = await createFileLedgerStore(DIR, f.fs).load('orzgk');
    expect((loaded as Ledger).range).toBeUndefined();
  });

  it('round-trips a range cursor, its frontier and its updatedAt', async () => {
    const f = makeFakeFs();
    const doc = withRange({ cursor: 3629950, frontier: 3630000, updatedAt: '2026-09-07T00:00:00.000Z' });
    f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(doc));
    expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toEqual(doc);
  });

  it('accepts a null cursor (never walked) and a 0 cursor (the id floor was reached)', async () => {
    for (const cursor of [null, 0]) {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(withRange({ cursor })));
      const loaded = await createFileLedgerStore(DIR, f.fs).load('orzgk');
      expect((loaded as Ledger).range).toEqual({ cursor });
    }
  });

  it("returns 'corrupt' on a malformed range section — the store is refused, never silently re-walked from the top", async () => {
    // (NaN is not in the list: JSON.stringify writes it as null, which is a VALID "never walked" cursor.)
    for (const range of ['x', 3, [], { cursor: '7' }, { cursor: -1 }, { cursor: 1.5 }, { cursor: true }]) {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(withRange(range)));
      expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toBe('corrupt');
    }
  });

  it("returns 'corrupt' on a malformed frontier — it is reported as a number and must never load as anything else", async () => {
    for (const range of [
      { cursor: 500, frontier: 'oops' },
      { cursor: 500, frontier: 0 },
      { cursor: 500, frontier: -1 },
      { cursor: 500, frontier: 1.5 },
      { cursor: 500, frontier: true },
      { cursor: 500, frontier: null },
    ]) {
      const f = makeFakeFs();
      f.files.set(path.join(DIR, 'orzgk.json'), JSON.stringify(withRange(range)));
      expect(await createFileLedgerStore(DIR, f.fs).load('orzgk')).toBe('corrupt');
    }
  });
});
