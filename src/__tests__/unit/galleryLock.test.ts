/** One gallery run at a time per ledger (red team S6): an O_EXCL lock file beside the ledger, taken over only when its pid is gone. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLock } from '../../services/images/galleryLock';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-lock-'));
  file = path.join(dir, 'ledger.jsonl.lock');
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireRunLock', () => {
  it('takes a free lock, writes the pid, and removes the file on release', () => {
    const l = acquireRunLock(file, 4242);
    expect(l.held).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('4242\n');
    if (l.held) l.release();
    expect(existsSync(file)).toBe(false);
  });

  it('a second run finds it held by a live pid, and says whose', () => {
    expect(acquireRunLock(file, process.pid).held).toBe(true);
    expect(acquireRunLock(file, 99)).toEqual({ held: false, pid: process.pid });
  });

  it('takes over a lock whose pid is gone', () => {
    writeFileSync(file, '777\n');
    jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); });
    const l = acquireRunLock(file, 5);
    expect(l.held).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('5\n');
  });

  it('a pid the OS will not let us signal (EPERM) is alive, not stale', () => {
    writeFileSync(file, '1\n');
    jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
    expect(acquireRunLock(file, 5)).toEqual({ held: false, pid: 1 });
  });

  it('a lock file with no pid yet is held while it is young and stale once it is old', () => {
    writeFileSync(file, '');
    expect(acquireRunLock(file, 5)).toEqual({ held: false });
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    expect(acquireRunLock(file, 6).held).toBe(true);
  });

  it('a garbage lock file is treated like a blank one', () => {
    writeFileSync(file, 'not a pid');
    expect(acquireRunLock(file, 5)).toEqual({ held: false });
  });

  it('release never removes a lock another run has since taken', () => {
    const l = acquireRunLock(file, 10);
    writeFileSync(file, '11\n');
    if (l.held) l.release();
    expect(readFileSync(file, 'utf8')).toBe('11\n');
  });

  it('release is harmless when the file is already gone', () => {
    const l = acquireRunLock(file, 10);
    rmSync(file);
    expect(() => l.held && l.release()).not.toThrow();
  });

  it('an error that is not "already exists" is not swallowed (a missing directory throws)', () => {
    expect(() => acquireRunLock(path.join(dir, 'no-such-dir', 'ledger.lock'), 1)).toThrow(/ENOENT/);
  });

  it('a lock path that cannot be read as a pid file (a directory) is reported held, not taken', () => {
    mkdirSync(file);
    expect(acquireRunLock(file, 1)).toEqual({ held: false });
  });

  it('two takeovers of one stale lock: exactly one wins, the other sees the winner alive', () => {
    writeFileSync(file, '777\n');
    jest.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 777) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    const a = acquireRunLock(file, 1);
    const b = acquireRunLock(file, 2);
    expect([a.held, b.held]).toEqual([true, false]);
  });
});
