/**
 * The gallery Job, run for real against loopback fixtures (MFC-GALLERY-2, red-team round 1). Each test starts the real entry
 * (`galleryCaptureCli.ts`) as a child process: the real global fetch, the env-built capture hook, the real object-store sink
 * against a fake S3, the real flush. Nothing here leaves 127.0.0.1.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { cliEnv, readDispatches, readLedger, runCli, useLockDir, startCli, startLoopback, withDispatchClock, writeWorklist, type Loopback } from '../helpers/galleryLoopback';

jest.setTimeout(120_000);

let lb: Loopback;
let dir: string;
let wl: string;
let ledger: string;
beforeEach(async () => {
  lb = await startLoopback();
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-loopback-'));
  useLockDir(dir);
  wl = path.join(dir, 'wl.jsonl');
  ledger = path.join(dir, 'ledger.jsonl');
});
afterEach(async () => {
  await lb.close();
  rmSync(dir, { recursive: true, force: true });
});

const putUrls = (): string[] => lb.puts.filter(p => p.replied).map(p => p.meta['x-amz-meta-url'] ?? '').sort();
const settled = (): string[] => readLedger(ledger).filter(r => r.s === 'stored').map(r => String(r.u ?? r.k)).sort();

describe('B1: the allow-list holds across redirects', () => {
  it('an off-host redirect is refused: no request reaches the target, nothing is stored, the url is never settled', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg', 'redir/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(r.out).not.toMatch(/failed:/);
    expect(lb.b).toEqual([]);
    expect(putUrls()).toEqual([lb.urlA('img/1.jpeg'), lb.urlA('img/3.jpeg')]);
    expect(settled().filter(u => u.includes('redir'))).toEqual([]);
    expect(settled().length).toBe(2);
    expect(r.report).toMatchObject({ stopped: 'done', fetched: 3, stored: 2, blocked: 1 });
  });

  it('a probe that meets one exits 5 and stores no off-host byte either', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg', 'redir/2.jpeg', 'img/3.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger, '--probe', '3'], cliEnv(lb));
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/PROBE FAIL/);
    expect(lb.b).toEqual([]);
    expect(putUrls().filter(u => u.includes('127.0.0.1'))).toEqual([]);
  });

  it('every hop of a same-host redirect chain goes through the per-host limiter', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir-chain/3/p.jpeg'] }]);
    const clock = path.join(dir, 'dispatch.jsonl');
    const r = await runCli(['--worklist', wl, '--ledger', ledger], withDispatchClock(cliEnv(lb), clock));
    expect(r.report).toMatchObject({ stored: 1 });
    const hops = lb.a.filter(s => s.path.startsWith('/redir-chain') || s.path.startsWith('/img/p.jpeg'));
    expect(hops.length).toBe(4);
    // a 100 ms row, measured where the limiter acts: the moment each hop is handed to the transport, inside the Job process. The
    // server's arrival gaps also carry connection setup that only the first hop pays (on a loaded CI runner: 52 ms at this row).
    const sent = readDispatches(clock).filter(d => d.url.startsWith(lb.urlA('')));
    expect(sent.map(d => `${d.lane} ${new URL(d.url).pathname}`)).toEqual(hops.map(h => `http ${h.path}`));
    const gaps = sent.slice(1).map((d, i) => d.t - sent[i]!.t);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(75);
  });

  it('a hop to another allowed host is followed, and carries no Referer', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir/9.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb, { GALLERY_ALLOWED_HOSTS: `http://localhost:${lb.portA},http://127.0.0.1:${lb.portB}` }));
    expect(r.report).toMatchObject({ stored: 1, blocked: 0 });
    expect(lb.a[0]!.headers.referer).toBe('https://item-page.invalid/item/1');
    expect(lb.b.length).toBe(1);
    expect(lb.b[0]!.headers.referer).toBeUndefined();
    expect(putUrls()).toEqual([`http://127.0.0.1:${lb.portB}/stolen/9.jpeg`]);
  });

  it('a redirect loop is refused after a few hops', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['redir-loop/x.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(lb.a.length).toBeLessThanOrEqual(7);
    expect(r.report).toMatchObject({ blocked: 1, stored: 0 });
    expect(settled()).toEqual([]);
  });
});

describe('B2: settled means the sink confirmed the durable put', () => {
  it('an S3 that answers every PUT 500 settles nothing, exits non-zero, and a resume against a healthy store refetches all three', async () => {
    lb.setS3('fail500');
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg', 'img/2.jpeg', 'img/3.jpeg'] }]);
    const first = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(first.code).not.toBe(0);
    expect(first.report).toMatchObject({ itemsWithFailures: 1 });
    expect(settled()).toEqual([]);

    lb.setS3('ok');
    const before = lb.a.length;
    const second = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(second.code).toBe(0);
    expect(lb.a.length - before).toBe(3);
    expect(putUrls().length).toBe(3);
    expect(settled().length).toBe(3);
  });

  it('kill -9 with a queued sink settles nothing the sink did not confirm, and a resume fetches the lot again', async () => {
    lb.setS3({ slowMs: 4000 });
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg', 'img/2.jpeg', 'img/3.jpeg'] }]);
    const run = startCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb, { RAW_STORE_CONCURRENCY: '1' }));
    const t0 = Date.now();
    while (lb.a.length < 3 && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 25));
    expect(lb.a.length).toBe(3);
    run.child.kill('SIGKILL');
    await run.done;
    expect(settled()).toEqual([]);

    // a killed run cannot release its lease: for up to 60 s an immediate resume is told LOCKED (exit 8, no request) ...
    lb.setS3('ok');
    const before = lb.a.length;
    const tooSoon = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(tooSoon.code).toBe(8);
    expect(lb.a.length).toBe(before);
    // ... and once its heartbeat is older than that, the lease is stale and the resume takes it over
    const lockFile = path.join(dir, 'gallery-capture.lock');
    const left = JSON.parse(readFileSync(lockFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(lockFile, JSON.stringify({ ...left, heartbeatAt: Date.now() - 61_000 }));
    const second = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(second.code).toBe(0);
    expect(lb.a.length - before).toBe(3);
    expect(settled().length).toBe(3);
  });
});

describe('S1: every (item, url) is settled and depicted on its own', () => {
  it('items that share a picture each get their depiction reported, and a second run fetches nothing', async () => {
    writeWorklist(lb, wl, [
      { id: 101, level: 'general', paths: ['img/shared.jpeg', 'img/a1.jpeg'] },
      { id: 202, paths: ['img/shared.jpeg'] },
      { id: 303, level: 'nsfw', paths: ['img/shared.jpeg', 'img/c1.jpeg'] },
    ]);
    const env = cliEnv(lb, { REPORT_CAPTURES: 'true', INGEST_BASE_URL: `http://127.0.0.1:${lb.portIng}` });
    const first = await runCli(['--worklist', wl, '--ledger', ledger], env);
    expect(first.code).toBe(0);
    expect(lb.a.filter(s => s.path === '/img/shared.jpeg').length).toBe(1);
    const depicts = (id: string): boolean => lb.ing.some(b => b.includes(id) && b.includes('shared.jpeg'));
    expect([depicts('101'), depicts('202'), depicts('303')]).toEqual([true, true, true]);
    const pairs = readLedger(ledger).filter(r => r.s === 'stored').map(r => `${String(r.i)} ${String(r.u).split('/').pop()}`).sort();
    expect(pairs).toEqual(['shop/101 a1.jpeg', 'shop/101 shared.jpeg', 'shop/202 shared.jpeg', 'shop/303 c1.jpeg', 'shop/303 shared.jpeg']);

    const before = lb.a.length;
    const second = await runCli(['--worklist', wl, '--ledger', ledger], env);
    expect(lb.a.length).toBe(before);
    expect(second.report).toMatchObject({ skippedLedger: 5, fetched: 0 });
  });
});

describe('S2: an over-long gallery is capped, never dropped whole', () => {
  it('150 entries: the first 100 by position are planned, and the report counts the 50 left out', async () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({ position: 149 - i, src: lb.urlA(`img/e${String(149 - i).padStart(3, '0')}.jpeg`) }));
    writeWorklist(lb, wl, [{ id: 1, entries }]);
    const r = await runCli(['--worklist', wl, '--dry-run'], cliEnv(lb));
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ mode: 'dry-run', items: 1, planned: 100, badLines: 0, entriesCapped: 50 });
    expect(r.out).toMatch(/shop\/1: 50 entries over the 100 cap left out/);
  });
});

describe('S3: one canonical spelling of a url', () => {
  it('hostile spellings of the same files are settled under one form, so a second run fetches none', async () => {
    const p = lb.portA;
    writeWorklist(lb, wl, [{
      id: 1,
      entries: [
        { position: 0, src: `http://LOCALHOST:${p}/img/h5.jpeg` },
        { position: 1, src: `http://localhost:${p}/img/%C3%A4-h8.jpeg` },
        { position: 2, src: `http://localhost:${p}/img/x/../h9.jpeg` },
        { position: 3, src: `http://%6cocalhost:${p}/img/h10.jpeg` },
        { position: 4, src: `http://localhost.:${p}/img/h11.jpeg#frag` },
      ],
    }]);
    const first = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(first.report).toMatchObject({ fetched: 5, stored: 5, notAllowedHost: 0 });
    const before = lb.a.length;
    const second = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(lb.a.length).toBe(before);
    expect(second.report).toMatchObject({ skippedLedger: 5, fetched: 0 });
  });
});

describe('S4: no explicit rate row, no run', () => {
  it.each([
    ['a row the parser drops (intervalMs as text)', JSON.stringify({ localhost: { intervalMs: '333' } })],
    ['no row for the allowed host', JSON.stringify({ 'other.example': { intervalMs: 333 } })],
    ['no IMAGE_HOST_RATE_JSON at all', undefined],
  ])('%s: exit 2, zero requests', async (_why, rate) => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb, { IMAGE_HOST_RATE_JSON: rate }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no explicit rate row for localhost/);
    expect(lb.a).toEqual([]);
  });
});

describe('S5: a 5xx storm pauses the run like a block does', () => {
  it('three consecutive 500s stop it, write the marker, and the next run honours it', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['s500/1', 's500/2', 's500/3', 's500/4', 's500/5', 's500/6'] }]);
    const first = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(first.code).toBe(3);
    expect(first.report).toMatchObject({ stopped: 'paused', trouble: 3 });
    expect(lb.a.length).toBe(3);
    const second = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(second.code).toBe(3);
    expect(second.report).toMatchObject({ stopped: 'paused-marker' });
    expect(lb.a.length).toBe(3);
  });
});

describe('S6: one run at a time', () => {
  const lockPath = (): string => path.join(dir, 'gallery-capture.lock');
  it('a second run on a live lease exits 8 with zero requests; the first is unharmed and releases the lock', async () => {
    lb.setS3('hold');
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }, { id: 2, paths: ['img/2.jpeg'] }]);
    // the first run's first item waits for the store, which the test answers only when it releases it: that run holds its lock until then
    const first = startCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb, { RAW_STORE_IMAGE_PUT_TIMEOUT_MS: '600000' }));
    const t0 = Date.now();
    while (lb.puts.length < 1 && Date.now() - t0 < 100_000) await new Promise(r => setTimeout(r, 25));
    const second = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(second.code).toBe(8);
    expect(second.out).toMatch(/another run holds/);
    expect(lb.a.map(s => s.path)).toEqual(['/img/1.jpeg']);
    lb.release();
    const done = await first.done;
    expect(done.code).toBe(0);
    expect(lb.a.map(s => s.path)).toEqual(['/img/1.jpeg', '/img/2.jpeg']);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('the lease, not a pid, decides: a lock whose heartbeat is old is taken over even if its pid lives; a fresh one holds even if its pid is gone', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['img/1.jpeg'] }]);
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    const lease = (heartbeatAt: number, pid: string | number) => JSON.stringify({ token: 't', hostname: 'pod-a', startedAt: heartbeatAt, heartbeatAt, pid: Number(pid) });
    writeFileSync(lockPath(), lease(Date.now() - 3_600_000, process.pid));
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(r.code).toBe(0);
    expect(existsSync(lockPath())).toBe(false);

    writeFileSync(lockPath(), lease(Date.now() - 1_000, gone));
    const held = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(held.code).toBe(8);
  });
});

describe('S7: SIGTERM stops the run', () => {
  it('stops issuing requests, settles only what the sink confirmed, and exits non-zero', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['slow/1.jpeg', 'slow/2.jpeg', 'slow/3.jpeg', 'slow/4.jpeg', 'slow/5.jpeg', 'slow/6.jpeg'] }]);
    const run = startCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    const t0 = Date.now();
    while (lb.a.length < 1 && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 25));
    run.child.kill('SIGTERM');
    const done = await run.done;
    expect(done.code).toBe(7);
    expect(done.out).toMatch(/"stopped":"interrupted"/);
    expect(lb.a.length).toBeLessThanOrEqual(2);
    const confirmed = new Set(lb.puts.filter(p => p.replied).map(p => p.meta['x-amz-meta-url']));
    for (const r of readLedger(ledger).filter(x => x.s === 'stored')) expect(confirmed.has(String(r.u))).toBe(true);
    expect(existsSync(path.join(dir, 'gallery-capture.lock'))).toBe(false);
  });
});

describe('S9: what the real entry wires', () => {
  it('a 20-photo item is fetched whole, not cut at the engine default of 12 (IMAGE_MAX_PER_ITEM is wired by main)', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: Array.from({ length: 20 }, (_, i) => `img/m${i}.jpeg`) }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(r.report).toMatchObject({ planned: 20, fetched: 20, stored: 20 });
  });

  it('a 404 is gone and settled; a 429 is a block that is not settled and pauses at the third', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['gone/1.jpeg', 's429/2.jpeg', 's429/3.jpeg', 's429/4.jpeg', 'img/5.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(r.code).toBe(3);
    expect(r.report).toMatchObject({ gone: 1, blocked: 3, stopped: 'paused' });
    expect(readLedger(ledger).filter(x => x.s === 'gone').length).toBe(1);
    expect(readLedger(ledger).filter(x => x.s === 'stored')).toEqual([]);
    expect(lb.a.length).toBe(4);
  });

  it('a body the http lane does not read (a 404, a declared length over the cap) is let go at once, not held open for the rest of the run', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['endless/404/a', 'slow/b.jpeg', 'endless-cl/c', 'slow/d.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(r.report).toMatchObject({ fetched: 4, stored: 2, gone: 1, oversize: 1 });
    const asked = (p: string): number => lb.a.find(s => s.path === p)!.t;
    const closed = (p: string): number | undefined => lb.closed.find(c => c.path === p)?.t;
    expect(closed('/endless/404/a')).toBeLessThan(asked('/slow/b.jpeg') + 1500);
    expect(closed('/endless-cl/c')).toBeLessThan(asked('/slow/d.jpeg') + 1500);
  });

  it('a declared body over the size cap is refused unread and settled oversize', async () => {
    writeWorklist(lb, wl, [{ id: 1, paths: ['big-cl/1.jpeg', 'img/2.jpeg'] }]);
    const r = await runCli(['--worklist', wl, '--ledger', ledger], cliEnv(lb));
    expect(r.report).toMatchObject({ oversize: 1, stored: 1 });
    expect(readLedger(ledger).filter(x => x.s === 'oversize').length).toBe(1);
    expect(putUrlsOf(lb)).toEqual([lb.urlA('img/2.jpeg')]);
  });
});

function putUrlsOf(l: Loopback): string[] {
  return l.puts.filter(p => p.replied).map(p => p.meta['x-amz-meta-url'] ?? '').sort();
}

