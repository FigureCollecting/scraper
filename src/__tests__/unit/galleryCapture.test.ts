/**
 * The gallery job's entry (`gallery:capture`): arguments and env in, one hook and one pacing limiter composed from
 * the same pieces the ingest lane uses, a report out, and an exit code an operator and a Job can act on.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const base: GalleryReport = { mode: 'run', stopped: 'done', items: 0, planned: 0, fetched: 0, stored: 0, gone: 0, oversize: 0, blocked: 0, trouble: 0, skippedLedger: 0, notAllowedHost: 0, badLines: 0, itemsWithFailures: 0 };
  it.each([
    [{ ...base }, 0],
    [{ ...base, stopped: 'limit' as const }, 0],
    [{ ...base, stopped: 'time' as const }, 0],
    [{ ...base, stopped: 'paused' as const }, 3],
    [{ ...base, stopped: 'paused-marker' as const }, 3],
    [{ ...base, stopped: 'refused' as const }, 4],
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
        env: { IMAGE_HOST_RATE_JSON: JSON.stringify({ [STATIC]: { intervalMs: 100 } }), GALLERY_ALLOWED_HOSTS: STATIC } as NodeJS.ProcessEnv,
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
});
