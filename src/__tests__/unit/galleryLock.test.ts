/**
 * One gallery run at a time (red team S6, then round 2's R2-S1/R2-S2): a LEASE in a lock file, not a pid. The file holds
 * {token, hostname, startedAt, heartbeatAt}; the owner refreshes heartbeatAt every 10 s; a lock is stale only when its heartbeat is
 * older than 60 s, whoever wrote it. A pid proves nothing in a container (node is PID 1 in every pod), so none is kept.
 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLock, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, type LockRecord } from '../../services/images/galleryLock';

let dir: string;
let file: string;
const NOW = 1_800_000_000_000;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-lock-'));
  file = path.join(dir, 'gallery-capture.lock');
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
const record = (over: Partial<LockRecord> = {}): LockRecord => ({ token: 'other', hostname: 'pod-a', startedAt: NOW - 600_000, heartbeatAt: NOW - 5_000, ...over });
const writeLock = (rec: LockRecord): void => writeFileSync(file, JSON.stringify(rec));
const readLock = (): LockRecord => JSON.parse(readFileSync(file, 'utf8')) as LockRecord;
const at = (now: number) => ({ now: () => now, hostname: 'me', token: 'mine' });

describe('the lease constants', () => {
  it('heartbeat every 10 s, stale after 60 s', () => {
    expect([LOCK_HEARTBEAT_MS, LOCK_STALE_MS]).toEqual([10_000, 60_000]);
  });
});

describe('acquireRunLock', () => {
  it('takes a free lock and writes a complete record; release removes the file', () => {
    const lock = acquireRunLock(file, at(NOW));
    expect(lock.held).toBe(true);
    expect(readLock()).toEqual({ token: 'mine', hostname: 'me', startedAt: NOW, heartbeatAt: NOW });
    if (lock.held) lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('leaves no scratch file behind (a candidate or the takeover guard)', () => {
    const lock = acquireRunLock(file, at(NOW));
    expect(require('node:fs').readdirSync(dir)).toEqual(['gallery-capture.lock']);
    if (lock.held) lock.release();
    expect(require('node:fs').readdirSync(dir)).toEqual([]);
  });

  it('a second run finds a fresh lock held, and says whose', () => {
    writeLock(record());
    const second = acquireRunLock(file, at(NOW));
    expect(second).toEqual({ held: false, owner: record() });
    expect(readLock()).toEqual(record());
  });

  it('a lock is stale only when its heartbeat is OLDER than 60 s: 60 s exactly still holds', () => {
    writeLock(record({ heartbeatAt: NOW - LOCK_STALE_MS }));
    expect(acquireRunLock(file, at(NOW)).held).toBe(false);
    writeLock(record({ heartbeatAt: NOW - LOCK_STALE_MS - 1 }));
    expect(acquireRunLock(file, at(NOW)).held).toBe(true);
    expect(readLock().token).toBe('mine');
  });

  it('takes over a stale lock whatever host wrote it, including its own (a pod that restarted keeps its name)', () => {
    writeLock(record({ hostname: 'me', heartbeatAt: NOW - 3_600_000 }));
    expect(acquireRunLock(file, at(NOW)).held).toBe(true);
    writeLock(record({ hostname: 'pod-z', heartbeatAt: NOW - 3_600_000 }));
    expect(acquireRunLock(file, { ...at(NOW), token: 'mine2' }).held).toBe(true);
    expect(readLock().token).toBe('mine2');
  });

  it('a live pid proves nothing: a stale lock is taken over even if a process with its pid is running, and a dead pid does not free a fresh one', () => {
    writeFileSync(file, JSON.stringify({ ...record({ heartbeatAt: NOW - 120_000 }), pid: process.pid }));
    expect(acquireRunLock(file, at(NOW)).held).toBe(true);
    writeFileSync(file, JSON.stringify({ ...record({ heartbeatAt: NOW - 1_000 }), pid: 2_147_483_000 }));
    expect(acquireRunLock(file, at(NOW)).held).toBe(false);
  });

  it.each([
    ['not json', 'not json'],
    ['an old pid-only file', '12345\n'],
    ['an empty file', ''],
    ['json of the wrong shape', '{"token":1}'],
    ['a record with a non-numeric heartbeat', JSON.stringify({ token: 't', hostname: 'h', startedAt: 1, heartbeatAt: 'soon' })],
  ])('%s: held while its file is young, taken over once it is older than 60 s', (_why, text) => {
    writeFileSync(file, text);
    const real = Date.now();
    expect(acquireRunLock(file, { now: () => real, hostname: 'me', token: 'mine' })).toEqual({ held: false });
    const old = new Date(real - 61_000);
    utimesSync(file, old, old);
    expect(acquireRunLock(file, { now: () => real, hostname: 'me', token: 'mine' }).held).toBe(true);
  });

  it('a lock that vanishes between the first look and the read is simply taken', () => {
    const lock = acquireRunLock(file, at(NOW));
    expect(lock.held).toBe(true);
    if (lock.held) lock.release();
    expect(acquireRunLock(file, { ...at(NOW), token: 'next' }).held).toBe(true);
  });

  it('an error that is not "already exists" is not swallowed (a missing directory throws)', () => {
    expect(() => acquireRunLock(path.join(dir, 'no-such-dir', 'x.lock'), at(NOW))).toThrow(/ENOENT/);
  });

  it('a lock path that is a directory is reported held, not taken', () => {
    mkdirSync(file);
    expect(acquireRunLock(file, at(NOW)).held).toBe(false);
  });
});

describe('heartbeat', () => {
  it('refreshes heartbeatAt and keeps everything else', () => {
    let now = NOW;
    const lock = acquireRunLock(file, { now: () => now, hostname: 'me', token: 'mine' });
    now += 10_000;
    expect(lock.held && lock.heartbeat()).toBe(true);
    expect(readLock()).toEqual({ token: 'mine', hostname: 'me', startedAt: NOW, heartbeatAt: NOW + 10_000 });
  });

  it('a lock another run has taken is lost: heartbeat says so and writes nothing', () => {
    const lock = acquireRunLock(file, at(NOW));
    writeLock(record({ token: 'taker', heartbeatAt: NOW }));
    expect(lock.held && lock.heartbeat()).toBe(false);
    expect(readLock().token).toBe('taker');
  });

  it('a lock that has been deleted is lost too', () => {
    const lock = acquireRunLock(file, at(NOW));
    rmSync(file);
    expect(lock.held && lock.heartbeat()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('startHeartbeat refreshes every 10 s on the clock, and release stops it', () => {
    jest.useFakeTimers({ now: NOW });
    const lock = acquireRunLock(file, { hostname: 'me', token: 'mine' });
    expect(lock.held).toBe(true);
    if (!lock.held) return;
    const lost = jest.fn();
    lock.startHeartbeat(lost);
    jest.advanceTimersByTime(LOCK_HEARTBEAT_MS * 3);
    expect(readLock().heartbeatAt).toBe(NOW + LOCK_HEARTBEAT_MS * 3);
    expect(lost).not.toHaveBeenCalled();
    lock.release();
    jest.advanceTimersByTime(LOCK_HEARTBEAT_MS * 3);
    expect(existsSync(file)).toBe(false);
  });

  it('startHeartbeat calls onLost once when the lock has been taken, and stops', () => {
    jest.useFakeTimers({ now: NOW });
    const lock = acquireRunLock(file, { hostname: 'me', token: 'mine' });
    if (!lock.held) throw new Error('expected the lock');
    const lost = jest.fn();
    lock.startHeartbeat(lost);
    writeLock(record({ token: 'taker', heartbeatAt: NOW }));
    jest.advanceTimersByTime(LOCK_HEARTBEAT_MS * 5);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(readLock().token).toBe('taker');
  });

  it('a second startHeartbeat does not start a second timer', () => {
    jest.useFakeTimers({ now: NOW });
    const lock = acquireRunLock(file, { hostname: 'me', token: 'mine' });
    if (!lock.held) throw new Error('expected the lock');
    lock.startHeartbeat(() => undefined);
    lock.startHeartbeat(() => undefined);
    expect(jest.getTimerCount()).toBe(1);
    lock.release();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('release', () => {
  it('never removes a lock another run has since taken', () => {
    const lock = acquireRunLock(file, at(NOW));
    writeLock(record({ token: 'taker' }));
    if (lock.held) lock.release();
    expect(readLock().token).toBe('taker');
  });

  it('is harmless when the file is already gone, and twice', () => {
    const lock = acquireRunLock(file, at(NOW));
    rmSync(file);
    expect(() => { if (lock.held) { lock.release(); lock.release(); } }).not.toThrow();
  });
});

describe('takeover is exclusive (R2-S2)', () => {
  it('the takeover guard is held by someone else: this run backs off and the stale lock is untouched', () => {
    writeLock(record({ heartbeatAt: NOW - 3_600_000 }));
    writeFileSync(`${file}.takeover`, JSON.stringify(record({ token: 'rival', heartbeatAt: NOW })));
    const second = acquireRunLock(file, at(NOW));
    expect(second.held).toBe(false);
    expect(readLock().token).toBe('other');
    expect(existsSync(`${file}.takeover`)).toBe(true);
  });

  it('a takeover guard left behind by a crashed taker (older than 30 s) does not wedge recovery', () => {
    writeLock(record({ heartbeatAt: NOW - 3_600_000 }));
    writeFileSync(`${file}.takeover`, JSON.stringify(record({ token: 'crashed' })));
    const real = Date.now();
    const old = new Date(real - 31_000);
    utimesSync(`${file}.takeover`, old, old);
    writeLock(record({ heartbeatAt: real - 3_600_000 }));
    expect(acquireRunLock(file, { now: () => real, hostname: 'me', token: 'mine' }).held).toBe(true);
    expect(existsSync(`${file}.takeover`)).toBe(false);
    expect(readLock().token).toBe('mine');
  });

  it('a lock another run replaced while this one waited for the guard is NOT removed: the fresh holder wins', () => {
    writeLock(record({ heartbeatAt: NOW - 3_600_000 }));
    const fsModule = require('node:fs') as typeof import('node:fs');
    const realLink = fsModule.linkSync; // captured BEFORE the spy: core modules are one shared object
    const spy = jest.spyOn(fsModule, 'linkSync').mockImplementation(((from: string, to: string) => {
      // the moment this run takes the guard, another run finishes ITS takeover and installs a fresh lock
      const out = realLink(from, to);
      if (to.endsWith('.takeover')) writeFileSync(file, JSON.stringify(record({ token: 'winner', heartbeatAt: NOW })));
      return out;
    }) as typeof linkSync);
    const second = acquireRunLock(file, at(NOW));
    spy.mockRestore();
    expect(second).toMatchObject({ held: false });
    expect(readLock().token).toBe('winner');
    expect(existsSync(`${file}.takeover`)).toBe(false);
  });

  it('a plain creator that slips in between the removal of a stale lock and the new create wins; this run is told so', () => {
    writeLock(record({ heartbeatAt: NOW - 3_600_000 }));
    const fsModule = require('node:fs') as typeof import('node:fs');
    const realLink = fsModule.linkSync;
    let creates = 0;
    const spy = jest.spyOn(fsModule, 'linkSync').mockImplementation(((from: string, to: string) => {
      // links onto the lock path: the first create (the lock exists) is #1; the create AFTER the stale lock was removed is #2
      if (to === file && ++creates === 2) writeFileSync(file, JSON.stringify(record({ token: 'slipped-in', heartbeatAt: NOW })));
      return realLink(from, to);
    }) as typeof linkSync);
    const second = acquireRunLock(file, at(NOW));
    spy.mockRestore();
    expect(second.held).toBe(false);
    expect(readLock().token).toBe('slipped-in');
  });
});
