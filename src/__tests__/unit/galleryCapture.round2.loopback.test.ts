/**
 * The gallery Job, run for real against loopback fixtures: the findings of the red team's SECOND round (MFC-GALLERY-2 fix round 2).
 * Same method as galleryCapture.loopback.test.ts: each test starts the real entry (`galleryCaptureCli.ts`) as a child process, with
 * the real fetch, the env-built capture hook, the real object-store sink against a fake S3 and the real flush. Nothing leaves 127.0.0.1.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliEnv, readLedger, runCli, useLockDir, startCli, startLoopback, writeWorklist, type Loopback } from '../helpers/galleryLoopback';

jest.setTimeout(120_000);

let lb: Loopback;
let dir: string;
let wl: string;
let ledger: string;
let lockPath: string;
beforeEach(async () => {
  lb = await startLoopback();
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-loopback2-'));
  useLockDir(dir);
  wl = path.join(dir, 'wl.jsonl');
  ledger = path.join(dir, 'ledger.jsonl');
  lockPath = path.join(dir, 'gallery-capture.lock');
});
afterEach(async () => {
  await lb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The run's env with the spine reporter pointed at the fake ingest endpoint, so a depiction is visible in `lb.ing`. */
const envR = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  cliEnv(lb, { REPORT_CAPTURES: 'true', INGEST_BASE_URL: `http://127.0.0.1:${lb.portIng}`, ...over });
const pairs = (): string[] => readLedger(ledger).filter(r => r.i !== undefined).map(r => `${String(r.i)} ${String(r.u).split('/').pop()} ${String(r.s)}`).sort();
const base = (): string[] => ['--worklist', wl, '--ledger', ledger];

describe('R2-B1a: a memo hit never settles bytes whose put was lost', () => {
  it('items sharing a picture while every PUT fails: nothing settled, nothing reported, the sharer is refetched; the next run stores it all', async () => {
    lb.setS3('fail500');
    writeWorklist(lb, wl, [{ id: 7101, paths: ['img/own101.png', 'img/shared.png'] }, { id: 7202, paths: ['img/shared.png'] }]);
    const first = await runCli(base(), envR());
    expect(first.code).toBe(6);
    expect(pairs()).toEqual([]);
    expect(lb.ing).toEqual([]);
    expect(first.report).toMatchObject({ itemsWithFailures: 2 });
    // the lost bytes were forgotten, so the second item fetched the picture itself instead of being told it was stored
    expect(lb.a.filter(s => s.path === '/img/shared.png')).toHaveLength(2);

    lb.setS3('ok');
    const second = await runCli(base(), envR());
    expect(second.code).toBe(0);
    expect(pairs()).toEqual(['shop/7101 own101.png stored', 'shop/7101 shared.png stored', 'shop/7202 shared.png stored']);
    expect(lb.a.filter(s => s.path === '/img/shared.png')).toHaveLength(3);
    expect(lb.ing).toHaveLength(3);
    expect(lb.ing.filter(b => b.includes('7101'))).toHaveLength(2);
    expect(lb.ing.filter(b => b.includes('7202'))).toHaveLength(1);
  });
});

describe('R2-B1b: the raw store\'s own size cap', () => {
  const MIB = 1024 * 1024;
  it('a photo over RAW_STORE_IMAGE_MAX_BYTES is settled skipped:too_large: counted, never reported, never retried (also for a sharer)', async () => {
    writeWorklist(lb, wl, [
      { id: 1, paths: [`bigimg/${2 * MIB}/p2mib.png`, 'img/small.png'] },
      { id: 2, paths: [`bigimg/${2 * MIB}/p2mib.png`] },
    ]);
    const env = envR({ RAW_STORE_IMAGE_MAX_BYTES: String(MIB) });
    const first = await runCli(base(), env);
    expect(first.code).toBe(0);
    expect(pairs()).toEqual(['shop/1 p2mib.png skipped:too_large', 'shop/1 small.png stored', 'shop/2 p2mib.png skipped:too_large']);
    expect(first.report).toMatchObject({ stored: 1, skippedTooLarge: 2, itemsWithFailures: 0 });
    expect(lb.puts.map(p => p.path.split('/').pop()).filter(f => f?.endsWith('.png'))).toHaveLength(1);
    expect(lb.ing).toHaveLength(1);
    expect(lb.ing[0]).toContain('small');
    expect(lb.ing.some(b => b.includes('p2mib'))).toBe(false);

    const before = lb.a.length;
    const second = await runCli(base(), env);
    expect(second.code).toBe(0);
    expect(lb.a.length).toBe(before);
    expect(second.report).toMatchObject({ skippedLedger: 3, fetched: 0 });
  });

  it('refuses to start (exit 2, zero requests) when RAW_STORE_IMAGE_MAX_BYTES is not set; a dry run does not need it', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/a.png'] }]);
    const run = await runCli(base(), envR({ RAW_STORE_IMAGE_MAX_BYTES: undefined }));
    expect(run.code).toBe(2);
    expect(run.out).toMatch(/RAW_STORE_IMAGE_MAX_BYTES/);
    expect(lb.a).toHaveLength(0);
    const probe = await runCli([...base(), '--probe', '1'], envR({ RAW_STORE_IMAGE_MAX_BYTES: undefined }));
    expect(probe.code).toBe(2);
    const dry = await runCli([...base(), '--dry-run'], envR({ RAW_STORE_IMAGE_MAX_BYTES: undefined }));
    expect(dry.code).toBe(0);
    const bad = await runCli(base(), envR({ RAW_STORE_IMAGE_MAX_BYTES: 'lots' }));
    expect(bad.code).toBe(2);
  });
});

describe('R2-B2: two different files never become one', () => {
  it('urls with a stray percent sign are fetched as the files they name, and settled once each', async () => {
    writeWorklist(lb, wl, [
      { id: 1, entries: [{ position: 0, src: lb.urlA('img/x%4%31.jpeg') }, { position: 1, src: lb.urlA('img/xA.jpeg') }] },
      { id: 2, entries: [{ position: 0, src: lb.urlA('img/y%4%31.jpeg') }] },
    ]);
    const first = await runCli(base(), envR());
    expect(first.code).toBe(0);
    expect(lb.a.map(s => s.path).sort()).toEqual(['/img/x%2541.jpeg', '/img/xA.jpeg', '/img/y%2541.jpeg']);
    expect(first.report).toMatchObject({ planned: 3, fetched: 3, stored: 3 });
    const before = lb.a.length;
    const second = await runCli(base(), envR());
    expect(lb.a.length).toBe(before);
    expect(second.report).toMatchObject({ skippedLedger: 3 });
  });
});

describe('R2-S3: a stop ends a redirect chain, including the hop already waiting for its slot', () => {
  it('SIGTERM during a 5-hop chain issues no further request and exits 7', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir-chain/5/z1.jpeg'] }]);
    const run = startCli(base(), envR({ IMAGE_HOST_RATE_JSON: JSON.stringify({ localhost: { intervalMs: 600 }, '127.0.0.1': { intervalMs: 600 } }) }));
    const t0 = Date.now();
    while (lb.a.length < 1 && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 10));
    run.child.kill('SIGTERM');
    const n0 = lb.a.length;
    const done = await run.done;
    expect(done.code).toBe(7);
    expect(lb.a.length - n0).toBe(0);
    expect(readLedger(ledger).filter(r => r.s !== undefined)).toEqual([]);
  });
});

describe('N1: the allow-list is per origin', () => {
  it('a redirect to another port of the allowed host is refused: no request, nothing stored or settled', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir-port/r1.jpeg'] }]);
    const run = await runCli(base(), envR({ GALLERY_ALLOWED_HOSTS: `http://localhost:${lb.portA}` }));
    expect(run.code).toBe(0);
    expect(lb.a2).toHaveLength(0);
    expect(lb.puts).toHaveLength(0);
    expect(pairs()).toEqual([]);
    expect(run.report).toMatchObject({ blocked: 1, stored: 0 });
  });

  it('a host named without a port allows only the default ports; a listed port allows exactly that one', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/p1.jpeg', 'img/p2.jpeg'] }]);
    const bare = await runCli(base(), envR({ GALLERY_ALLOWED_HOSTS: 'http://localhost' }));
    expect(bare.report).toMatchObject({ notAllowedHost: 2, planned: 0 });
    expect(lb.a).toHaveLength(0);
    const wrongPort = await runCli(base(), envR({ GALLERY_ALLOWED_HOSTS: `http://localhost:${lb.portA2}` }));
    expect(wrongPort.report).toMatchObject({ notAllowedHost: 2, planned: 0 });
    expect(lb.a).toHaveLength(0);
    const listed = await runCli(base(), envR({ GALLERY_ALLOWED_HOSTS: `http://localhost:${lb.portA}` }));
    expect(listed.code).toBe(0);
    expect(listed.report).toMatchObject({ planned: 2, stored: 2 });
  });

  it('refuses a malformed allow-list entry (exit 2)', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/p1.jpeg'] }]);
    for (const bad of ['localhost:0', 'localhost:99999', 'local host', 'localhost/path', 'ftp://localhost', 'http://', 'http://localhost/path']) {
      const run = await runCli(base(), envR({ GALLERY_ALLOWED_HOSTS: bad }));
      expect(run.code).toBe(2);
    }
    expect(lb.a).toHaveLength(0);
  });
});

describe('N2: credentials in a redirect Location', () => {
  it('a hop whose Location carries credentials is refused before any request, and the password is never printed', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir-userinfo/u1.jpeg'] }]);
    const run = await runCli(base(), envR({ GALLERY_ALLOWED_HOSTS: `http://localhost:${lb.portA}` }));
    expect(run.code).toBe(0);
    expect(lb.a.map(s => s.path)).toEqual(['/redir-userinfo/u1.jpeg']);
    expect(run.out).not.toContain('hunter2');
    expect(pairs()).toEqual([]);
    expect(run.report).toMatchObject({ blocked: 1 });
  });
});

describe('N4: the report says what was stored', () => {
  it('stored counts files the store confirmed; fetched counts what was downloaded', async () => {
    lb.setS3('fail500');
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/n1.png', 'img/n2.png', 'img/n3.png'] }]);
    const lost = await runCli(base(), envR());
    expect(lost.code).toBe(6);
    expect(lost.report).toMatchObject({ fetched: 3, stored: 0, itemsWithFailures: 1 });
    lb.setS3('ok');
    const ok = await runCli(base(), envR());
    expect(ok.report).toMatchObject({ fetched: 3, stored: 3, itemsWithFailures: 0 });
  });
});

describe('R2-S1: the lock is a lease, not a pid', () => {
  const lockFile = (over: Record<string, unknown>): void => writeFileSync(lockPath, JSON.stringify({ token: 'abc', hostname: 'pod-a', startedAt: Date.now() - 3_600_000, heartbeatAt: Date.now() - 3_600_000, ...over }));

  it('a lock whose heartbeat is old is taken over, whatever host or pid wrote it, and is removed at the end', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    lockFile({});
    const run = await runCli(base(), envR());
    expect(run.code).toBe(0);
    expect(lb.a).toHaveLength(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a lock with a fresh heartbeat from another pod holds: exit 8 (its own code), zero requests, the owner named', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    lockFile({ heartbeatAt: Date.now() - 5_000, startedAt: Date.now() - 600_000 });
    const run = await runCli(base(), envR());
    expect(run.code).toBe(8);
    expect(run.out).toMatch(/LOCKED: another run holds .*gallery-capture\.lock.*pod-a/);
    expect(lb.a).toHaveLength(0);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).token).toBe('abc');
  });

  it('a pause marker still exits 3: each code has one meaning', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['s500/1.jpeg', 's500/2.jpeg', 's500/3.jpeg', 'img/4.jpeg'] }]);
    const first = await runCli([...base(), '--pause-after', '3'], envR());
    expect(first.code).toBe(3);
    const again = await runCli(base(), envR());
    expect(again.code).toBe(3);
    expect(again.out).toMatch(/PAUSED/);
  });
});

describe('N3: the lock protects the host, not one ledger file', () => {
  it('a probe with its own --ledger cannot run beside a live run', async () => {
    lb.setS3('hold');
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }, { id: 2, paths: ['img/2.jpeg'] }]);
    // the first run's first item waits for the store, which the test answers only when it releases it: that run holds its lock until then
    const first = startCli(base(), envR({ RAW_STORE_IMAGE_PUT_TIMEOUT_MS: '600000' }));
    const t0 = Date.now();
    while (lb.puts.length < 1 && Date.now() - t0 < 100_000) await new Promise(r => setTimeout(r, 25));
    const probe = await runCli(['--worklist', wl, '--ledger', path.join(dir, 'probe-ledger.jsonl'), '--probe', '2'], envR());
    expect(probe.code).toBe(8);
    expect(lb.a.map(s => s.path)).toEqual(['/img/1.jpeg']);
    lb.release();
    expect((await first.done).code).toBe(0);
    expect(lb.a.map(s => s.path)).toEqual(['/img/1.jpeg', '/img/2.jpeg']);
  });

  it('GALLERY_LOCK_PATH moves the lock', async () => {
    lb.setS3('hold');
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    const elsewhere = path.join(dir, 'elsewhere.lock');
    // the first run's first item waits for the store, which the test answers only when it releases it: that run holds its lock until then
    const first = startCli(base(), envR({ GALLERY_LOCK_PATH: elsewhere, RAW_STORE_IMAGE_PUT_TIMEOUT_MS: '600000' }));
    const t0 = Date.now();
    while (lb.puts.length < 1 && Date.now() - t0 < 100_000) await new Promise(r => setTimeout(r, 25));
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    const second = await runCli(base(), envR({ GALLERY_LOCK_PATH: elsewhere }));
    expect(second.code).toBe(8);
    expect(lb.a.length).toBe(1);
    lb.release();
    expect((await first.done).code).toBe(0);
    expect(existsSync(elsewhere)).toBe(false);
  });
});
