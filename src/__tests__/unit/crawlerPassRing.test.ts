/**
 * QB-U36 part B — the pass-strategy RING FILE (`<siteId>.passes.ndjson` beside the ledgers): one JSON line per
 * pass, the last 30 days, about 1 MB, oldest dropped first, written via tmp file + rename so it survives Job
 * cleanup and a restart. Plus the /health/detailed hostClock reader the crawler's entrypoint wires.
 */
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEmptyLedger, type FsLike } from '../../crawler/ledger';
import {
  PASS_RING_MAX_AGE_MS,
  PASS_RING_MAX_BYTES,
  createFilePassRingStore,
  createHealthHostClockReader,
  domainIdOf,
  storeHostOf,
  type PassStrategyRecord,
} from '../../crawler/passStrategy';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-08T03:30:00.000Z');

const rec = (atMs: number, over: Partial<PassStrategyRecord> = {}): PassStrategyRecord => ({
  strategyVersion: 1,
  siteId: 'mfc',
  at: new Date(atMs).toISOString(),
  strategy: 'lists',
  strategyParams: { ratio: '2:1', step: 1 },
  listsCompanies: [{ entryId: '7620' }],
  listsDomains: [9, 1],
  listsPerList: [],
  idsDiscovered: 0,
  idsNew: 0,
  idsDup: 0,
  challenges: 0,
  cooldowns: 0,
  listsStepMs: 0,
  storePassMs: 0,
  hostClock: null,
  ...over,
});

const memFs = () => {
  const files = new Map<string, string>();
  const ops: string[] = [];
  const fs: FsLike = {
    readFile: async (p) => {
      const c = files.get(p);
      if (c === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return c;
    },
    writeFile: async (p, data) => {
      ops.push(`write ${p}`);
      files.set(p, data);
    },
    rename: async (from, to) => {
      ops.push(`rename ${from} ${to}`);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    mkdir: async (p) => {
      ops.push(`mkdir ${p}`);
      return undefined;
    },
  };
  return { fs, files, ops };
};

const lines = (s: string | undefined): PassStrategyRecord[] =>
  (s ?? '')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as PassStrategyRecord);

describe('pass ring — append, order, restart', () => {
  it('creates <siteId>.passes.ndjson in the ledger dir, one line per record, through a tmp file and a rename', async () => {
    const m = memFs();
    const ring = createFilePassRingStore('/ledgers', { fs: m.fs, now: () => NOW, pid: 7 });
    const out = await ring.append('mfc', rec(NOW));
    expect(m.ops).toEqual(['mkdir /ledgers', 'write /ledgers/mfc.passes.ndjson.tmp-7', 'rename /ledgers/mfc.passes.ndjson.tmp-7 /ledgers/mfc.passes.ndjson']);
    expect(m.files.get('/ledgers/mfc.passes.ndjson')).toBe(`${JSON.stringify(rec(NOW))}\n`);
    expect(out).toEqual({ kept: 1, droppedAged: 0, droppedOversize: 0, droppedMalformed: 0 });
  });

  it('a NEW store over the same files (a restart) appends after what an earlier process wrote', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qb-u36-ring-'));
    try {
      await createFilePassRingStore(dir, { now: () => NOW - 2 * 60 * 60 * 1000 }).append('mfc', rec(NOW - 2 * 60 * 60 * 1000));
      await createFilePassRingStore(dir, { now: () => NOW - 60 * 60 * 1000 }).append('mfc', rec(NOW - 60 * 60 * 1000));
      await createFilePassRingStore(dir, { now: () => NOW }).append('mfc', rec(NOW, { strategy: 'tap' }));
      const got = lines(await fsp.readFile(path.join(dir, 'mfc.passes.ndjson'), 'utf8'));
      expect(got.map((r) => [r.at, r.strategy])).toEqual([
        ['2026-10-08T01:30:00.000Z', 'lists'],
        ['2026-10-08T02:30:00.000Z', 'lists'],
        ['2026-10-08T03:30:00.000Z', 'tap'],
      ]);
      expect((await fsp.readdir(dir)).sort()).toEqual(['mfc.passes.ndjson']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults to the real fs and the wall clock', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qb-u36-ring-'));
    try {
      const before = Date.now();
      expect(await createFilePassRingStore(dir).append('mfc', rec(before))).toEqual({ kept: 1, droppedAged: 0, droppedOversize: 0, droppedMalformed: 0 });
      expect(lines(await fsp.readFile(path.join(dir, 'mfc.passes.ndjson'), 'utf8'))).toEqual([rec(before)]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one file per store', async () => {
    const m = memFs();
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW });
    await ring.append('mfc', rec(NOW));
    await ring.append('hpoi', rec(NOW, { siteId: 'hpoi' }));
    expect([...m.files.keys()].sort()).toEqual(['/l/hpoi.passes.ndjson', '/l/mfc.passes.ndjson']);
  });

  it('refuses an unsafe siteId before touching the disk', async () => {
    const m = memFs();
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW });
    await expect(ring.append('../etc/passwd', rec(NOW))).rejects.toThrow(/unsafe siteId/);
    expect(m.ops).toEqual([]);
  });
});

describe('pass ring — 30 days', () => {
  it('defaults: 30 days and 1 MiB', () => {
    expect(PASS_RING_MAX_AGE_MS).toBe(30 * DAY_MS);
    expect(PASS_RING_MAX_BYTES).toBe(1024 * 1024);
  });

  it('drops records older than 30 days; a record exactly 30 days old stays', async () => {
    const m = memFs();
    const file = '/l/mfc.passes.ndjson';
    m.files.set(file, [rec(NOW - 31 * DAY_MS), rec(NOW - 30 * DAY_MS - 1), rec(NOW - 30 * DAY_MS), rec(NOW - DAY_MS)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const out = await createFilePassRingStore('/l', { fs: m.fs, now: () => NOW }).append('mfc', rec(NOW));
    expect(lines(m.files.get(file)).map((r) => r.at)).toEqual([new Date(NOW - 30 * DAY_MS).toISOString(), new Date(NOW - DAY_MS).toISOString(), new Date(NOW).toISOString()]);
    expect(out).toEqual({ kept: 3, droppedAged: 2, droppedOversize: 0, droppedMalformed: 0 });
  });

  it('a custom age bound is honoured', async () => {
    const m = memFs();
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW, maxAgeMs: DAY_MS });
    m.files.set('/l/mfc.passes.ndjson', `${JSON.stringify(rec(NOW - 2 * DAY_MS))}\n`);
    expect(await ring.append('mfc', rec(NOW))).toMatchObject({ kept: 1, droppedAged: 1 });
  });
});

describe('pass ring — about 1 MB', () => {
  it('drops the OLDEST lines until the file fits; a file exactly at the bound is kept whole', async () => {
    const m = memFs();
    const one = `${JSON.stringify(rec(NOW))}\n`.length;
    // Room for exactly three lines.
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW, maxBytes: 3 * one });
    for (let i = 0; i < 3; i++) await ring.append('mfc', rec(NOW, { idsNew: i }));
    expect(lines(m.files.get('/l/mfc.passes.ndjson')).map((r) => r.idsNew)).toEqual([0, 1, 2]);
    const out = await ring.append('mfc', rec(NOW, { idsNew: 3 }));
    expect(lines(m.files.get('/l/mfc.passes.ndjson')).map((r) => r.idsNew)).toEqual([1, 2, 3]);
    expect(out).toEqual({ kept: 3, droppedAged: 0, droppedOversize: 1, droppedMalformed: 0 });
    expect(m.files.get('/l/mfc.passes.ndjson')!.length).toBe(3 * one);
  });

  it('one byte over the bound drops the oldest line', async () => {
    const m = memFs();
    const one = `${JSON.stringify(rec(NOW))}\n`.length;
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW, maxBytes: 2 * one - 1 });
    await ring.append('mfc', rec(NOW, { idsNew: 0 }));
    await ring.append('mfc', rec(NOW, { idsNew: 1 }));
    expect(lines(m.files.get('/l/mfc.passes.ndjson')).map((r) => r.idsNew)).toEqual([1]);
  });

  it('measures BYTES, not characters', async () => {
    const m = memFs();
    const ascii = `${JSON.stringify(rec(NOW, { listsCompanies: [{ entryId: 'aa' }] }))}\n`;
    const wide = `${JSON.stringify(rec(NOW, { listsCompanies: [{ entryId: 'é' }] }))}\n`;
    expect(wide.length).toBe(ascii.length - 1);
    // Room for two ascii lines: the 'é' line is one character shorter but one byte longer than one of them.
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW, maxBytes: Buffer.byteLength(ascii) + Buffer.byteLength(wide) - 1 });
    await ring.append('mfc', rec(NOW, { listsCompanies: [{ entryId: 'aa' }] }));
    await ring.append('mfc', rec(NOW, { listsCompanies: [{ entryId: 'é' }] }));
    expect(lines(m.files.get('/l/mfc.passes.ndjson')).map((r) => r.listsCompanies[0].entryId)).toEqual(['é']);
  });

  it('the newest record is always kept, even alone over the bound', async () => {
    const m = memFs();
    const ring = createFilePassRingStore('/l', { fs: m.fs, now: () => NOW, maxBytes: 10 });
    await ring.append('mfc', rec(NOW - 1000));
    const out = await ring.append('mfc', rec(NOW));
    expect(lines(m.files.get('/l/mfc.passes.ndjson')).map((r) => r.at)).toEqual([new Date(NOW).toISOString()]);
    expect(out).toEqual({ kept: 1, droppedAged: 0, droppedOversize: 1, droppedMalformed: 0 });
  });
});

describe('pass ring — a damaged or unreadable file', () => {
  it('drops lines that are not records (torn write, garbage, no instant) and still appends', async () => {
    const m = memFs();
    m.files.set(
      '/l/mfc.passes.ndjson',
      [JSON.stringify(rec(NOW - 1000)), '{"strategyVersion":1,"at":"never"}', '[1,2]', 'null', '{"strategyVersion":1', '', JSON.stringify({ ...rec(NOW - 500), at: 42 })].join('\n'),
    );
    const out = await createFilePassRingStore('/l', { fs: m.fs, now: () => NOW }).append('mfc', rec(NOW));
    expect(lines(m.files.get('/l/mfc.passes.ndjson')).map((r) => r.at)).toEqual([new Date(NOW - 1000).toISOString(), new Date(NOW).toISOString()]);
    expect(out).toEqual({ kept: 2, droppedAged: 0, droppedOversize: 0, droppedMalformed: 5 });
  });

  it('a file that cannot be READ is left exactly as found and the append rejects (the crawler WARNs)', async () => {
    const m = memFs();
    m.fs.readFile = async () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    await expect(createFilePassRingStore('/l', { fs: m.fs, now: () => NOW }).append('mfc', rec(NOW))).rejects.toThrow('EACCES');
    expect(m.ops).toEqual([]);
  });

  it('a failed write rejects', async () => {
    const m = memFs();
    m.fs.writeFile = async () => Promise.reject(new Error('ENOSPC'));
    await expect(createFilePassRingStore('/l', { fs: m.fs, now: () => NOW }).append('mfc', rec(NOW))).rejects.toThrow('ENOSPC');
  });
});

describe('hostClock reader — our own /health/detailed', () => {
  const res = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (body instanceof Error ? Promise.reject(body) : body),
    text: async () => JSON.stringify(body),
  });

  it('GETs <scraper>/health/detailed once and returns its hostClock block', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const block = { mode: 'on', hosts: [] };
    const read = createHealthHostClockReader('http://scraper.test', async (url, init) => {
      seen.push([url, init?.method]);
      return res(200, { status: 'healthy', hostClock: block });
    }, 5000);
    expect(await read()).toEqual(block);
    expect(seen).toEqual([['http://scraper.test/health/detailed', 'GET']]);
  });

  it('reads the block off a degraded 500 too (it is kept there on purpose)', async () => {
    const read = createHealthHostClockReader('http://scraper.test', async () => res(500, { status: 'degraded', hostClock: { mode: 'off', hosts: [] } }), 5000);
    expect(await read()).toEqual({ mode: 'off', hosts: [] });
  });

  it('a body without the block, or no JSON at all, reads as undefined', async () => {
    expect(await createHealthHostClockReader('http://s', async () => res(200, { status: 'healthy' }), 5000)()).toBeUndefined();
    expect(await createHealthHostClockReader('http://s', async () => res(200, [1]), 5000)()).toBeUndefined();
    expect(await createHealthHostClockReader('http://s', async () => res(404, new Error('not json')), 5000)()).toBeUndefined();
  });

  it('a transport failure rejects (the crawler WARNs and records hostClock null)', async () => {
    await expect(createHealthHostClockReader('http://s', async () => Promise.reject(new Error('ECONNREFUSED')), 5000)()).rejects.toThrow('ECONNREFUSED');
  });

  it('aborts a read that outlives its timeout', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const read = createHealthHostClockReader('http://s', (_url, init) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }, 2000);
      const p = read();
      jest.advanceTimersByTime(1999);
      expect(signal?.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(p).rejects.toThrow('aborted');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the store host and a list\'s domain', () => {
  const ledger = (urls: string[]) => {
    const l = createEmptyLedger('mfc');
    urls.forEach((u, i) => (l.enqueued[String(i)] = { at: new Date(NOW).toISOString(), collectUrl: u }));
    return l;
  };

  it('the host of the first entry with a parseable url, normalised (case, www.)', () => {
    expect(storeHostOf(ledger(['not a url', 'https://WWW.MyFigureCollection.net/item/1', 'https://other.test/x']))).toBe('myfigurecollection.net');
  });

  it('no entry, or no parseable url: null', () => {
    expect(storeHostOf(ledger([]))).toBeNull();
    expect(storeHostOf(ledger(['not a url', '']))).toBeNull();
  });

  it('domainIdOf reads the -d<n> suffix and nothing else', () => {
    expect(domainIdOf('company-7620-d9')).toBe(9);
    expect(domainIdOf('company-7620-d1')).toBe(1);
    expect(domainIdOf('company-7620-d12')).toBe(12);
    expect(domainIdOf('gsc-top')).toBeNull();
    expect(domainIdOf('company-7620-d9x')).toBeNull();
    expect(domainIdOf('company-7620-d')).toBeNull();
  });
});
