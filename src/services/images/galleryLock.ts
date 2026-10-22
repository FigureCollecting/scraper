/**
 * galleryLock — one gallery run at a time per ledger (MFC-GALLERY-2 red team S6).
 *
 * Two Jobs on one ledger double the request rate and fetch everything twice. The lock is an O_EXCL file beside the ledger holding the
 * owner's pid. A lock whose pid is gone (a killed run) is stale and taken over; a lock whose pid lives is not, and the second run
 * makes no request. A lock file with no pid in it yet (its owner is between open and write) counts as held until it is old.
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

export type RunLock = { held: true; release(): void } | { held: false; pid?: number };

/** A lock file that never got a pid is only stale after this long. */
const BLANK_LOCK_STALE_MS = 10_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryCreate(file: string, pid: number): RunLock | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw err;
  }
  try {
    writeSync(fd, `${pid}\n`);
  } finally {
    closeSync(fd);
  }
  return {
    held: true,
    release() {
      try {
        if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file);
      } catch { /* already gone */ }
    },
  };
}

export function acquireRunLock(file: string, pid: number = process.pid, now: () => number = Date.now): RunLock {
  const first = tryCreate(file, pid);
  if (first !== undefined) return first;
  let owner: number | undefined;
  let blank = false;
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (/^[0-9]+$/.test(text)) owner = Number(text);
    else blank = true;
  } catch {
    return tryCreate(file, pid) ?? { held: false };
  }
  const stale = owner !== undefined ? !alive(owner) : blank && now() - statSync(file).mtimeMs > BLANK_LOCK_STALE_MS;
  if (!stale) return { held: false, ...(owner !== undefined ? { pid: owner } : {}) };
  try { unlinkSync(file); } catch { /* another run took it over first */ }
  return tryCreate(file, pid) ?? { held: false };
}
