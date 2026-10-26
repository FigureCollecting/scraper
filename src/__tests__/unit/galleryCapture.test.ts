/**
 * The gallery job's entry (`gallery:capture`): arguments and env in, one hook and one pacing limiter composed from
 * the same pieces the ingest lane uses, a report out, and an exit code an operator and a Job can act on.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { galleryExitCode, main, parseGalleryArgs } from '../../services/images/galleryCapture';
import type { GalleryReport } from '../../services/images/galleryDriver';
import { buildImageHostPolicy } from '../../services/images/imageHostPolicy';
import type { ImageBytesFetcher } from '../../services/images/imageBytes';

const STATIC = 'static.myfigurecollection.net';
const U = (n: number) => `https://${STATIC}/upload/pictures/2022/10/14/${n}.jpeg`;
const line = (id: string, nums: number[]) =>
  JSON.stringify({ site: 'mfc', itemId: id, pageUrl: `https://myfigurecollection.net/item/${id}`, rank: 0, entries: nums.map((n, i) => ({ position: i, src: U(n) })) });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const POLICY = buildImageHostPolicy({ [STATIC]: { lane: 'http', egress: 'direct' } });

describe('parseGalleryArgs', () => {
  it('has safe defaults and reads the env', () => {
    const a = parseGalleryArgs([], { GALLERY_WORKLIST_PATH: '/w.jsonl', GALLERY_LEDGER_PATH: '/l.jsonl' } as NodeJS.ProcessEnv);
    expect(a).toMatchObject({ worklist: '/w.jsonl', ledger: '/l.jsonl', allowedHosts: [], pauseAfter: 3, pauseMinutes: 360, sourceClass: 'unknown', dryRun: false, resume: false });
    expect(a.probe).toBeUndefined();
    expect(a.maxFiles).toBeUndefined();
  });

  it('flags win over the env', () => {
    const a = parseGalleryArgs(['--worklist', '/a', '--ledger', '/b', '--probe', '--max-files', '50', '--max-minutes', '30', '--pause-after', '5', '--pause-minutes', '60', '--resume', '--dry-run', '--source-class', 'manufacturer_press'], { GALLERY_WORKLIST_PATH: '/w' } as NodeJS.ProcessEnv);
    expect(a).toMatchObject({ worklist: '/a', ledger: '/b', probe: 20, maxFiles: 50, maxMinutes: 30, pauseAfter: 5, pauseMinutes: 60, resume: true, dryRun: true, sourceClass: 'manufacturer_press' });
  });

  it('takes a probe size, and reads GALLERY_ALLOWED_HOSTS as a list', () => {
    const a = parseGalleryArgs(['--probe', '8'], { GALLERY_ALLOWED_HOSTS: 'a.example, B.example' } as NodeJS.ProcessEnv);
    expect(a.probe).toBe(8);
    expect(a.allowedHosts).toEqual(['a.example', 'b.example']);
  });

  it.each([
    [['--bogus']],
    [['--max-files', '0']],
    [['--max-files', 'x']],
    [['--pause-after', '0']],
    [['--probe', '0']],
    [['--probe', '1000']],
    [['--source-class', 'press']],
    [['--worklist']],
    [['stray']],
  ])('rejects %j', argv => {
    expect(() => parseGalleryArgs(argv, {} as NodeJS.ProcessEnv)).toThrow(/usage|must|requires/i);
  });
});

describe('parseGalleryArgs: the environment', () => {
  it('reads the pause and source-class settings from env', () => {
    const a = parseGalleryArgs([], { GALLERY_PAUSE_AFTER: '7', GALLERY_PAUSE_MINUTES: '15', GALLERY_SOURCE_CLASS: 'retailer_studio' } as NodeJS.ProcessEnv);
    expect(a).toMatchObject({ pauseAfter: 7, pauseMinutes: 15, sourceClass: 'retailer_studio' });
  });

  it.each([
    [{ GALLERY_PAUSE_AFTER: 'x' }],
    [{ GALLERY_PAUSE_MINUTES: '0' }],
    [{ GALLERY_SOURCE_CLASS: 'press' }],
  ])('rejects a bad %j', env => {
    expect(() => parseGalleryArgs([], env as NodeJS.ProcessEnv)).toThrow(/usage|must/i);
  });
});

describe('galleryExitCode', () => {
  const base: GalleryReport = { mode: 'run', stopped: 'done', items: 0, planned: 0, fetched: 0, stored: 0, gone: 0, oversize: 0, skippedTooLarge: 0, skippedNotImage: 0, blocked: 0, trouble: 0, skippedLedger: 0, notAllowedHost: 0, badLines: 0, entriesCapped: 0, itemsWithFailures: 0, bytesRead: 0, budget: null };
  it.each([
    [{ ...base }, 0],
    [{ ...base, stopped: 'limit' as const }, 0],
    [{ ...base, stopped: 'time' as const }, 0],
    [{ ...base, stopped: 'budget' as const }, 0],
    [{ ...base, stopped: 'paused' as const }, 3],
    [{ ...base, stopped: 'paused-marker' as const }, 3],
    [{ ...base, stopped: 'refused' as const }, 4],
    // B2: the raw store did not confirm an item's files: never a clean exit, whatever else the run did
    [{ ...base, itemsWithFailures: 1 }, 6],
    [{ ...base, stopped: 'limit' as const, itemsWithFailures: 2 }, 6],
    [{ ...base, stopped: 'paused' as const, itemsWithFailures: 1 }, 3],
    // a probe answers one question and the code follows the printed verdict: PASS is 0, anything else 5 (6 is for a real run)
    [{ ...base, mode: 'probe' as const, itemsWithFailures: 1, probe: { verdict: 'PASS' as const, reasons: [], notes: [], evidence: [] } }, 5],
    [{ ...base, mode: 'probe' as const, itemsWithFailures: 1, probe: { verdict: 'FAIL' as const, reasons: ['x'], notes: [], evidence: [] } }, 5],
    [{ ...base, mode: 'probe' as const, itemsWithFailures: 0, probe: { verdict: 'FAIL' as const, reasons: ['x'], notes: [], evidence: [] } }, 5],
    // a probe that tripped the pause exits by its verdict, not by the pause (the marker and the PAUSED line are still there)
    [{ ...base, mode: 'probe' as const, stopped: 'paused' as const, probe: { verdict: 'FAIL' as const, reasons: ['x'], notes: [], evidence: [] } }, 5],
    [{ ...base, mode: 'probe' as const, stopped: 'paused-marker' as const }, 3],
    [{ ...base, mode: 'probe' as const, stopped: 'interrupted' as const, probe: { verdict: 'INCONCLUSIVE' as const, reasons: ['x'], notes: [], evidence: [] } }, 7],
    // S7: stopped by a signal
    [{ ...base, stopped: 'interrupted' as const }, 7],
    [{ ...base, stopped: 'interrupted' as const, itemsWithFailures: 1 }, 7],
    [{ ...base, mode: 'probe' as const, probe: { verdict: 'PASS' as const, reasons: [], notes: [], evidence: [] } }, 0],
    [{ ...base, mode: 'probe' as const, probe: { verdict: 'FAIL' as const, reasons: ['x'], notes: [], evidence: [] } }, 5],
    [{ ...base, mode: 'probe' as const, probe: { verdict: 'INCONCLUSIVE' as const, reasons: ['x'], notes: [], evidence: [] } }, 5],
  ])('%#', (report, code) => {
    expect(galleryExitCode(report)).toBe(code);
  });
});

describe('main', () => {
  let dir: string;
  let work: string;
  let ledger: string;
  const out: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-cli-'));
    work = path.join(dir, 'wl.jsonl');
    ledger = path.join(dir, 'ledger.jsonl');
    writeFileSync(work, [line('1', [1, 2]), line('2', [3])].join('\n') + '\n');
    out.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  type Reply = { status: number; type?: string };
  const IMG: Reply = { status: 200, type: 'image/png' };
  const deps = (reply: (url: string) => Reply = () => IMG, enabled = true, flushed: string[] = []) => {
    const fetched: string[] = [];
    return {
      fetched, flushed,
      deps: {
        env: { IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 100 } }), GALLERY_ALLOWED_HOSTS: STATIC, RAW_STORE_IMAGE_MAX_BYTES: '10485760', GALLERY_LOCK_PATH: path.join(dir, 'gallery-capture.lock') } as NodeJS.ProcessEnv,
        print: (s: string) => void out.push(s),
        policy: POLICY,
        baseFetch: async (url: string) => {
          const r = reply(url);
          const body = r.status === 200 && r.type === 'image/png' ? PNG : Buffer.from('<html>no</html>');
          const h = new Map<string, string>(r.type ? [['content-type', r.type]] : []);
          return { status: r.status, url, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
        },
        makeHook: (fetchBytes: ImageBytesFetcher) => ({
          async capture(req: { ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
            for (const r of req.ruleset.describeImages!(req.fields)) { fetched.push(r.url); await fetchBytes(r.url, {}); }
          },
          async drain() { /* nothing in flight */ },
          stats: () => ({ enabled, reason: enabled ? undefined : 'PERSIST_RAW_IMAGES is not true', attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: {} }),
        }) as never,
        flush: async () => { flushed.push('flushed'); },
        sink: { flush: async () => undefined, stats: () => ({ assetFailed: 0, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) },
      },
    };
  };
  const reportOf = (): Record<string, unknown> => JSON.parse(out.find(l => l.startsWith('GALLERY-REPORT '))!.slice('GALLERY-REPORT '.length));

  // hands-off plan C1: the engine names no site, so no host is built in; the run says which host it may fetch from
  it('exits 2 and fetches nothing when no allowed host is named', async () => {
    const d = deps();
    const bare = { ...d.deps, env: { ...d.deps.env, GALLERY_ALLOWED_HOSTS: '' } as NodeJS.ProcessEnv };
    expect(await main(['--worklist', work, '--ledger', ledger], bare)).toBe(2);
    expect(out.join('\n')).toMatch(/GALLERY_ALLOWED_HOSTS must name the image host/);
    expect(d.fetched).toEqual([]);
  });

  it('a dry run reads the list and fetches nothing', async () => {
    const d = deps();
    const code = await main(['--worklist', work, '--dry-run'], d.deps);
    expect(code).toBe(0);
    expect(d.fetched).toEqual([]);
    expect(reportOf()).toMatchObject({ mode: 'dry-run', items: 2, planned: 3, fetched: 0 });
  });

  it('a run fetches the list, records it in the ledger, flushes the sink once, and a second run fetches nothing', async () => {
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', ledger], d.deps)).toBe(0);
    expect(d.fetched).toEqual([U(1), U(2), U(3)]);
    expect(d.flushed).toEqual(['flushed']);
    expect(readFileSync(ledger, 'utf8').trim().split('\n').length).toBe(3);
    const again = deps();
    out.length = 0;
    expect(await main(['--worklist', work, '--ledger', ledger], again.deps)).toBe(0);
    expect(again.fetched).toEqual([]);
    expect(reportOf()).toMatchObject({ skippedLedger: 3, fetched: 0 });
  });

  it('exits 3 when blocked and leaves a pause marker the next run honours', async () => {
    const d = deps(() => ({ status: 429 }));
    expect(await main(['--worklist', work, '--ledger', ledger, '--pause-after', '2'], d.deps)).toBe(3);
    out.length = 0;
    const next = deps();
    expect(await main(['--worklist', work, '--ledger', ledger], next.deps)).toBe(3);
    expect(next.fetched).toEqual([]);
    expect(reportOf()).toMatchObject({ stopped: 'paused-marker' });
  });

  it('exits 4 when the image lane is off', async () => {
    const d = deps(() => IMG, false);
    expect(await main(['--worklist', work, '--ledger', ledger], d.deps)).toBe(4);
    expect(d.fetched).toEqual([]);
  });

  it('a probe that passes exits 0 and prints the verdict', async () => {
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', ledger, '--probe', '2'], d.deps)).toBe(0);
    expect(out.join('\n')).toMatch(/PROBE PASS/);
    expect(d.fetched.length).toBe(2);
  });

  it('a probe that fails exits 5', async () => {
    const d = deps(() => ({ status: 200, type: 'text/html' }));
    expect(await main(['--worklist', work, '--ledger', ledger, '--probe', '3', '--pause-after', '99'], d.deps)).toBe(5);
    expect(out.join('\n')).toMatch(/PROBE FAIL/);
  });

  it('exits 2 for a bad flag, a missing list, an unreadable list, or a run with no ledger', async () => {
    expect(await main(['--bogus'], deps().deps)).toBe(2);
    expect(await main([], deps().deps)).toBe(2);
    expect(await main(['--worklist', path.join(dir, 'nope.jsonl'), '--ledger', ledger], deps().deps)).toBe(2);
    expect(await main(['--worklist', work], deps().deps)).toBe(2);
    expect(out.join('\n')).toMatch(/ledger/i);
  });

  it('a dry run needs no ledger, and reports a live pause marker with its time', async () => {
    const d = deps();
    writeFileSync(ledger, JSON.stringify({ pause: Date.now() + 3600_000, why: 'test' }) + '\n');
    expect(await main(['--worklist', work, '--ledger', ledger, '--dry-run'], d.deps)).toBe(3);
    expect(out.join('\n')).toMatch(/PAUSED until \d{4}-\d{2}-\d{2}T/);
    out.length = 0;
    expect(await main(['--worklist', work, '--ledger', ledger, '--dry-run', '--resume'], d.deps)).toBe(0);
  });

  it('prints the refusal and stops on a time budget between items', async () => {
    const d = deps(() => IMG, false);
    expect(await main(['--worklist', work, '--dry-run'], d.deps)).toBe(4);
    expect(out.join('\n')).toMatch(/REFUSED: the image capture lane is off/);
    out.length = 0;
    const clock = { t: 0 };
    const slow = deps(() => { clock.t += 3 * 60_000; return IMG; });
    expect(await main(['--worklist', work, '--ledger', ledger + '2', '--max-minutes', '2'], { ...slow.deps, now: () => clock.t })).toBe(0);
    expect(reportOf()).toMatchObject({ stopped: 'time' });
  });

  it('exits 1 when the run crashes, still flushing the sink', async () => {
    const d = deps();
    const boom = { ...d.deps, makeHook: () => { throw new Error('hook could not be built'); } };
    expect(await main(['--worklist', work, '--ledger', ledger], boom as never)).toBe(1);
    expect(out.join('\n')).toMatch(/hook could not be built/);
  });

  // S4: a host with no decided rate would run at the limiter's own default, faster than the rate chosen for it
  it.each([
    ['no IMAGE_HOST_RATE_JSON at all', undefined],
    ['a row for another host only', JSON.stringify({ 'other.example': { intervalMs: 333 } })],
    ['a row that is not readable', '{not json'],
    ['a row with an interval outside the allowed range', JSON.stringify({ [STATIC]: { intervalMs: 5 } })],
  ])('exits 2 with zero requests when the allowed host has no explicit rate row: %s', async (_why, rateJson) => {
    const d = deps();
    const env = { ...d.deps.env } as Record<string, string | undefined>;
    if (rateJson === undefined) delete env.IMAGE_HOST_RATE_JSON; else env.IMAGE_HOST_RATE_JSON = rateJson;
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, env: env as NodeJS.ProcessEnv })).toBe(2);
    expect(out.join('\n')).toMatch(new RegExp(`REFUSED: no explicit rate row for ${STATIC.replace(/\./g, '\\.')}`));
    expect(d.fetched).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('a dry run needs no rate row (it makes no request)', async () => {
    const d = deps();
    const env = { ...d.deps.env } as Record<string, string | undefined>;
    delete env.IMAGE_HOST_RATE_JSON;
    expect(await main(['--worklist', work, '--dry-run'], { ...d.deps, env: env as NodeJS.ProcessEnv })).toBe(0);
  });

  // S6 (round 2: R2-S1, N3): one run at a time per HOST, on a lease
  const lockFile = (): string => path.join(dir, 'gallery-capture.lock');
  const lease = (over: Record<string, unknown> = {}): string => JSON.stringify({ token: 'other', hostname: 'pod-a', startedAt: Date.now() - 600_000, heartbeatAt: Date.now() - 5_000, ...over });

  it('a second run exits 8 (LOCKED has its own code) with zero requests while a fresh lease is held, and says whose it is', async () => {
    writeFileSync(lockFile(), lease());
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', ledger], d.deps)).toBe(8);
    expect(out.join('\n')).toMatch(/LOCKED: another run holds .*gallery-capture\.lock \(pod-a, heartbeat \d+s ago\); this one made no request/);
    expect(d.fetched).toEqual([]);
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).token).toBe('other');
  });

  it('a lock nobody can read is reported without an owner', async () => {
    writeFileSync(lockFile(), '');
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', ledger], d.deps)).toBe(8);
    expect(out.join('\n')).toMatch(/LOCKED: another run holds .*\.lock; this one made no request/);
  });

  it('a lease whose heartbeat is older than 60 s is taken over, whoever wrote it', async () => {
    writeFileSync(lockFile(), lease({ heartbeatAt: Date.now() - 120_000 }));
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', ledger], d.deps)).toBe(0);
    expect(d.fetched.length).toBe(3);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('takes its own lock for the run and always lets it go: after a clean run and after a crash', async () => {
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', ledger], d.deps)).toBe(0);
    expect(existsSync(lockFile())).toBe(false);
    const boom = { ...deps().deps, makeHook: () => { throw new Error('hook could not be built'); } };
    expect(await main(['--worklist', work, '--ledger', ledger], boom as never)).toBe(1);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('the lock does not depend on --ledger: another ledger in the same directory is blocked (a probe cannot run beside a run)', async () => {
    writeFileSync(lockFile(), lease());
    const d = deps();
    expect(await main(['--worklist', work, '--ledger', path.join(dir, 'probe-ledger.jsonl'), '--probe', '2'], d.deps)).toBe(8);
    expect(d.fetched).toEqual([]);
  });

  it('GALLERY_LOCK_PATH names the lock, wherever the ledger is', async () => {
    const elsewhere = path.join(dir, 'locks', 'x.lock');
    mkdirSync(path.dirname(elsewhere));
    writeFileSync(elsewhere, lease());
    const d = deps();
    const env = { ...d.deps.env, GALLERY_LOCK_PATH: elsewhere } as NodeJS.ProcessEnv;
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, env })).toBe(8);
    rmSync(elsewhere);
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, env })).toBe(0);
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('GALLERY_LEDGER_PATH decides the default lock directory over the --ledger flag', async () => {
    const other = path.join(dir, 'state');
    mkdirSync(other);
    writeFileSync(path.join(other, 'gallery-capture.lock'), lease());
    const d = deps();
    const env = { ...d.deps.env, GALLERY_LOCK_PATH: undefined, GALLERY_LEDGER_PATH: path.join(other, 'ledger.jsonl') } as NodeJS.ProcessEnv;
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, env })).toBe(8);
  });

  it.each([
    ['a run', ['--worklist', 'WORK', '--ledger', 'LEDGER']],
    ['a probe', ['--worklist', 'WORK', '--ledger', 'LEDGER', '--probe', '2']],
  ])('%s exits 2 with zero requests when neither GALLERY_LOCK_PATH nor GALLERY_LEDGER_PATH is set (no lock beside --ledger)', async (_why, argv) => {
    const d = deps();
    const env = { ...d.deps.env } as Record<string, string | undefined>;
    delete env.GALLERY_LOCK_PATH;
    delete env.GALLERY_LEDGER_PATH;
    const real = argv.map(a => (a === 'WORK' ? work : a === 'LEDGER' ? ledger : a));
    expect(await main(real, { ...d.deps, env: env as NodeJS.ProcessEnv })).toBe(2);
    expect(out.join('\n')).toMatch(/GALLERY_LOCK_PATH.*GALLERY_LEDGER_PATH|GALLERY_LEDGER_PATH.*GALLERY_LOCK_PATH/);
    expect(d.fetched).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('a dry run needs no lock location', async () => {
    const d = deps();
    const env = { ...d.deps.env } as Record<string, string | undefined>;
    delete env.GALLERY_LOCK_PATH;
    delete env.GALLERY_LEDGER_PATH;
    expect(await main(['--worklist', work, '--dry-run'], { ...d.deps, env: env as NodeJS.ProcessEnv })).toBe(0);
  });

  it('a dry run takes no lock', async () => {
    writeFileSync(lockFile(), lease());
    expect(await main(['--worklist', work, '--ledger', ledger, '--dry-run'], deps().deps)).toBe(0);
  });

  it('a run that LOSES its lease (another run took the lock) stops at once and exits 7', async () => {
    const d = deps();
    const slowHook = {
      async capture(req: { ruleset: { describeImages?: (f: Record<string, unknown>) => Array<{ url: string }> }; fields: Record<string, unknown> }) {
        for (const r of req.ruleset.describeImages!(req.fields)) d.fetched.push(r.url);
        writeFileSync(lockFile(), lease({ token: 'taker', heartbeatAt: Date.now() }));
        await new Promise(r => setTimeout(r, 250));
      },
      async drain() { /* nothing */ },
      stats: () => ({ enabled: true, attempted: 0, stored: 0, deduped: 0, failed: 0, residentialBytesToday: 0, skipped: {} }),
    };
    const code = await main(['--worklist', work, '--ledger', ledger], { ...d.deps, makeHook: () => slowHook as never, lockHeartbeatMs: 20 });
    expect(code).toBe(7);
    expect(d.fetched).toEqual([U(1), U(2)]);
    expect(out.join('\n')).toMatch(/LOST the lock/);
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).token).toBe('taker');
  });

  // B1b: the store's own size cap is part of the Job's env
  it.each([['unset', undefined], ['zero', '0'], ['negative', '-5'], ['not a number', 'lots'], ['empty', '']])('exits 2 with zero requests when RAW_STORE_IMAGE_MAX_BYTES is %s', async (_why, value) => {
    const d = deps();
    const env = { ...d.deps.env } as Record<string, string | undefined>;
    if (value === undefined) delete env.RAW_STORE_IMAGE_MAX_BYTES; else env.RAW_STORE_IMAGE_MAX_BYTES = value;
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, env: env as NodeJS.ProcessEnv })).toBe(2);
    expect(out.join('\n')).toMatch(/RAW_STORE_IMAGE_MAX_BYTES/);
    expect(d.fetched).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('a dry run does not need RAW_STORE_IMAGE_MAX_BYTES', async () => {
    const d = deps();
    const env = { ...d.deps.env } as Record<string, string | undefined>;
    delete env.RAW_STORE_IMAGE_MAX_BYTES;
    expect(await main(['--worklist', work, '--dry-run'], { ...d.deps, env: env as NodeJS.ProcessEnv })).toBe(0);
  });

  // N1: GALLERY_ALLOWED_HOSTS entries are origins
  it('R3-N4: entries are [http://|https://]host[:port]; a bare host or host:port is https, and the form is normalised', () => {
    const entries = (v: string) => parseGalleryArgs([], { GALLERY_ALLOWED_HOSTS: v } as NodeJS.ProcessEnv).allowedHosts;
    expect(entries('A.example, HTTPS://b.example:8443, http://C.example:8080, http://d.example')).toEqual(['a.example', 'b.example:8443', 'http://c.example:8080', 'http://d.example']);
    for (const bad of ['ftp://a.example', 'http://', 'http://a.example/x', 'https://a.example/']) {
      expect(() => entries(bad)).toThrow(/GALLERY_ALLOWED_HOSTS/);
    }
  });

  it('R3-N4: an http:// entry is logged as a WARNING at start (cleartext), a bare or https entry is not', async () => {
    const d = deps();
    const withHttp = { ...d.deps.env, GALLERY_ALLOWED_HOSTS: `${STATIC},http://${STATIC}` } as NodeJS.ProcessEnv;
    await main(['--worklist', work, '--dry-run'], { ...d.deps, env: withHttp });
    const warned = out.filter(l => /WARNING/.test(l) && /cleartext/i.test(l));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`http://${STATIC}`);
    expect(warned[0]).not.toContain(`https://`);
    out.length = 0;
    await main(['--worklist', work, '--dry-run'], { ...d.deps, env: { ...d.deps.env, GALLERY_ALLOWED_HOSTS: `${STATIC},https://${STATIC}:8443` } as NodeJS.ProcessEnv });
    expect(out.filter(l => /WARNING/.test(l))).toEqual([]);
  });

  it('GALLERY_ALLOWED_HOSTS takes host or host:port, and a malformed entry is a usage error', () => {
    expect(parseGalleryArgs([], { GALLERY_ALLOWED_HOSTS: 'A.example, b.example:8443' } as NodeJS.ProcessEnv).allowedHosts).toEqual(['a.example', 'b.example:8443']);
    for (const bad of ['a.example:0', 'a.example:70000', 'a b', 'a.example/x', 'ftp://a.example']) {
      expect(() => parseGalleryArgs([], { GALLERY_ALLOWED_HOSTS: bad } as NodeJS.ProcessEnv)).toThrow(/GALLERY_ALLOWED_HOSTS/);
    }
  });

  it('the rate row of an origin entry is the row of its HOST NAME: with the row the run goes ahead, without it the message names the host', async () => {
    const d = deps();
    const withPort = { ...d.deps.env, GALLERY_ALLOWED_HOSTS: `${STATIC}:443` } as NodeJS.ProcessEnv;
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, env: withPort })).toBe(0);
    expect(d.fetched).toEqual([U(1), U(2), U(3)]);
    const noRow = { ...withPort, IMAGE_HOST_RATE_JSON: '{}' } as NodeJS.ProcessEnv;
    expect(await main(['--worklist', work, '--ledger', ledger + '2'], { ...d.deps, env: noRow })).toBe(2);
    expect(out.join('\n')).toContain(`no explicit rate row for ${STATIC} in IMAGE_HOST_RATE_JSON`);
  });

  // S7: a signal reaches the run through deps.signal
  it('a run already told to stop makes no request, settles nothing and exits 7', async () => {
    const d = deps();
    const ac = new AbortController();
    ac.abort();
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, signal: ac.signal })).toBe(7);
    expect(d.fetched).toEqual([]);
    expect(reportOf()).toMatchObject({ stopped: 'interrupted', fetched: 0 });
    expect(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '').toBe('');
  });

  // B2: the raw store did not confirm the bytes
  it('exits 6 and settles nothing when the raw store reports a lost put', async () => {
    const d = deps();
    let lost = 0;
    const sink = { flush: async () => { lost += 1; }, stats: () => ({ assetFailed: lost, dropped: 0, droppedBytes: 0, assetRefusedReserve: 0 }) };
    expect(await main(['--worklist', work, '--ledger', ledger], { ...d.deps, sink })).toBe(6);
    expect(reportOf()).toMatchObject({ itemsWithFailures: 2 });
    expect(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '').toBe('');
  });
});
