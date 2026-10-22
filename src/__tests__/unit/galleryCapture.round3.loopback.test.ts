/**
 * The gallery Job, run for real against loopback fixtures: the findings of the red team's THIRD round (MFC-GALLERY-2 fix round 3).
 * Same method as the earlier loopback files: the real entry as a child process, the real fetch, hook and sink against a fake S3.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliEnv, readLedger, runCli, useLockDir, startLoopback, writeWorklist, type Loopback } from '../helpers/galleryLoopback';

jest.setTimeout(120_000);

let lb: Loopback;
let dir: string;
let wl: string;
let ledger: string;
beforeEach(async () => {
  lb = await startLoopback();
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-loopback3-'));
  useLockDir(dir);
  wl = path.join(dir, 'wl.jsonl');
  ledger = path.join(dir, 'ledger.jsonl');
});
afterEach(async () => {
  await lb.close();
  rmSync(dir, { recursive: true, force: true });
});

const envR = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  cliEnv(lb, { REPORT_CAPTURES: 'true', INGEST_BASE_URL: `http://127.0.0.1:${lb.portIng}`, ...over });
const base = (): string[] => ['--worklist', wl, '--ledger', ledger];
const pairs = (): string[] => readLedger(ledger).filter(r => r.i !== undefined).map(r => `${String(r.i)} ${String(r.u).split('/').pop()} ${String(r.s)}`).sort();
const verdict = (out: string): string | undefined => /^PROBE (PASS|FAIL|INCONCLUSIVE)/m.exec(out)?.[1];

describe('R3-S1: a body the store will not keep is settled, not refetched for ever', () => {
  const MIB = 1024 * 1024;
  it('an HTML page served as image/jpeg and a BMP: settled skipped:not_image, counted, never reported; three runs, no repeat request', async () => {
    writeWorklist(lb, wl, [
      { id: 8001, paths: ['img/g1.png', 'img/g2.png', 'img/g3.png', 'htmlimg/h1.jpg'] },
      { id: 8002, paths: ['bmp/b1.bmp', 'img/g4.png'] },
      { id: 8003, paths: ['htmlimg/h1.jpg'] }, // shares the HTML page with item 8001: settled the same way, through the memo
    ]);
    const first = await runCli(base(), envR());
    expect(first.code).toBe(0);
    expect(pairs()).toEqual([
      'shop/8001 g1.png stored', 'shop/8001 g2.png stored', 'shop/8001 g3.png stored', 'shop/8001 h1.jpg skipped:not_image',
      'shop/8002 b1.bmp skipped:not_image', 'shop/8002 g4.png stored', 'shop/8003 h1.jpg skipped:not_image',
    ]);
    expect(first.report).toMatchObject({ stored: 4, skippedNotImage: 3, itemsWithFailures: 0 });
    expect(lb.puts.filter(p => p.replied)).toHaveLength(4);
    expect(lb.ing).toHaveLength(4);
    expect(lb.ing.some(b => b.includes('h1.jpg') || b.includes('b1.bmp'))).toBe(false);

    const afterFirst = lb.a.length;
    for (const n of [2, 3]) {
      const again = await runCli(base(), envR());
      expect([n, again.code, lb.a.length]).toEqual([n, 0, afterFirst]);
      expect(again.report).toMatchObject({ fetched: 0, skippedLedger: 7 });
    }
  });

  it('a host that answers with these bodies pauses the run after three in a row; a good file in between resets the count', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['htmlimg/a1.jpg', 'htmlimg/a2.jpg', 'htmlimg/a3.jpg', 'img/after.png'] }]);
    const paused = await runCli(base(), envR());
    expect(paused.code).toBe(3);
    expect(lb.a.map(s => s.path)).toEqual(['/htmlimg/a1.jpg', '/htmlimg/a2.jpg', '/htmlimg/a3.jpg']);
    expect(paused.out).toMatch(/PAUSED/);
    // they are settled (never retried) and the marker holds the rest back
    expect(pairs()).toEqual(['shop/1 a1.jpg skipped:not_image', 'shop/1 a2.jpg skipped:not_image', 'shop/1 a3.jpg skipped:not_image']);

    writeWorklist(lb, wl, [{ id: 2, paths: ['htmlimg/x1.jpg', 'htmlimg/x2.jpg', 'img/ok.png', 'htmlimg/x3.jpg'] }]);
    const mixed = await runCli(['--worklist', wl, '--ledger', path.join(dir, 'second.jsonl')], envR());
    expect(mixed.code).toBe(0);
    expect(mixed.report).toMatchObject({ skippedNotImage: 3, stored: 1, blocked: 0 });
  });

  it('a body over the store\'s ceiling that is also not an image is the ceiling\'s: settled skipped:too_large (the sink checks size first)', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['htmlimg/this-page-is-longer-than-the-tiny-ceiling-below.jpg'] }]);
    const run = await runCli(base(), envR({ RAW_STORE_IMAGE_MAX_BYTES: '16' }));
    expect(run.code).toBe(0);
    expect(pairs()).toEqual(['shop/1 this-page-is-longer-than-the-tiny-ceiling-below.jpg skipped:too_large']);
  });

  it('the probe prints FAIL, never PASS, for bodies the store would not keep, and the exit code agrees', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['htmlimg/p1.jpg', 'htmlimg/p2.jpg', 'htmlimg/p3.jpg'] }]);
    const run = await runCli([...base(), '--probe', '3'], envR());
    expect([verdict(run.out), run.code]).toEqual(['FAIL', 5]);
    expect(run.out).toMatch(/not an image/i);
  });

  it('the probe prints FAIL, and exits 5, when the store did not confirm a write (it used to print PASS and exit 6)', async () => {
    lb.setS3('fail500');
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/p1.png', 'img/p2.png'] }]);
    const run = await runCli([...base(), '--probe', '2'], envR());
    expect([verdict(run.out), run.code]).toEqual(['FAIL', 5]);
    expect(run.out).toMatch(/did not confirm/i);
  });

  it('the probe prints FAIL when the store skipped a file as over its ceiling', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: [`bigimg/${2 * MIB}/p2mib.png`, 'img/p2.png'] }]);
    const run = await runCli([...base(), '--probe', '2'], envR({ RAW_STORE_IMAGE_MAX_BYTES: String(MIB) }));
    expect([verdict(run.out), run.code]).toEqual(['FAIL', 5]);
    expect(run.out).toMatch(/ceiling/i);
  });

  it('a clean probe still prints PASS and exits 0', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/p1.png', 'img/p2.png'] }]);
    const run = await runCli([...base(), '--probe', '2'], envR());
    expect([verdict(run.out), run.code]).toEqual(['PASS', 0]);
    expect(existsSync(ledger) ? readLedger(ledger).filter(r => r.i !== undefined) : []).toEqual([]);
  });
});

describe('R3-N3: no lock location, no run (the lock never follows the --ledger flag)', () => {
  const lockless = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => envR({ GALLERY_LOCK_PATH: undefined, GALLERY_LEDGER_PATH: undefined, ...over });

  it('exits 2 with zero requests when neither GALLERY_LOCK_PATH nor GALLERY_LEDGER_PATH is set; the lock is never made beside --ledger', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.png'] }]);
    const run = await runCli(base(), lockless());
    expect(run.code).toBe(2);
    expect(run.out).toMatch(/GALLERY_LOCK_PATH/);
    expect(run.out).toMatch(/GALLERY_LEDGER_PATH/);
    expect(lb.a).toHaveLength(0);
    expect(existsSync(path.join(dir, 'gallery-capture.lock'))).toBe(false);
    const probe = await runCli([...base(), '--probe', '1'], lockless());
    expect(probe.code).toBe(2);
    expect(lb.a).toHaveLength(0);
  });

  it('a dry run makes no request and needs no lock location', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.png'] }]);
    const run = await runCli([...base(), '--dry-run'], lockless());
    expect(run.code).toBe(0);
  });

  it('GALLERY_LEDGER_PATH alone places the lock beside THAT ledger, whatever --ledger a run is given', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.png'] }]);
    const state = path.join(dir, 'state');
    mkdirSync(state);
    writeFileSync(path.join(state, 'gallery-capture.lock'), JSON.stringify({ token: 'abc', hostname: 'pod-a', startedAt: Date.now() - 600_000, heartbeatAt: Date.now() - 5_000 }));
    const run = await runCli(base(), lockless({ GALLERY_LEDGER_PATH: path.join(state, 'ledger.jsonl') }));
    expect(run.code).toBe(8);
    expect(lb.a).toHaveLength(0);
  });
});
