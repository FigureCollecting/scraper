/**
 * galleryLock — one gallery run at a time (MFC-GALLERY-2 red team S6; round 2: R2-S1, R2-S2).
 *
 * Two Jobs on one host double the request rate and fetch everything twice. The lock is a LEASE in a file: {token, hostname,
 * startedAt, heartbeatAt}. The owner refreshes heartbeatAt every 10 s; a lock is stale only when its heartbeat is older than 60 s,
 * whoever wrote it. No pid is kept, because a pid proves nothing in a container: node is PID 1 in every pod, so "is that pid alive"
 * is always yes and one SIGKILL would stall every later run for good.
 *
 * Creating the file is `link()` of a complete candidate (atomic, content never half-written, EEXIST for the loser). Taking over a
 * stale lock is serialised by a short-lived guard file (`<lock>.takeover`, same atomic create): the holder of the guard re-reads the
 * lock, removes it only if it is still the same stale lock, then creates its own with the same atomic create. A rename-aside takeover
 * was considered and rejected: rename acts on the PATH, so a slower racer would move the fresh lock a faster one had just installed.
 * A run that finds the guard held backs off (it is told "held"); a guard left by a crashed taker is removed after 30 s.
 *
 * What a lease cannot do: stop a process that was frozen for over a minute and wakes believing it still holds the lock. Its next
 * heartbeat finds another token and reports the lock lost; the caller stops the run (exit 7).
 */
import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';

export const LOCK_HEARTBEAT_MS = 10_000;
export const LOCK_STALE_MS = 60_000;
/** A takeover guard is held for microseconds; one this old belongs to a taker that died. */
export const TAKEOVER_GUARD_STALE_MS = 30_000;
const MAX_ATTEMPTS = 6;
/** Filesystems that cannot hard-link answer with one of these; the exclusive create below is the same guarantee, less tidy. */
const LINK_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV']);

export interface LockRecord { token: string; hostname: string; startedAt: number; heartbeatAt: number }
export type RunLock =
  | {
      held: true;
      token: string;
      /** Refresh heartbeatAt. False when the lock is no longer ours (taken over, or the file is gone). */
      heartbeat(): boolean;
      /** Refresh every `everyMs` (default 10 s) until released; `onLost` runs once if the lock is found taken. The timer never keeps the process alive. */
      startHeartbeat(onLost: () => void, everyMs?: number): void;
      release(): void;
    }
  | { held: false; owner?: LockRecord };

interface LockOptions { now?: () => number; hostname?: string; token?: string }

type Look = { kind: 'missing' } | { kind: 'record'; rec: LockRecord } | { kind: 'unreadable'; mtimeMs: number };

const isRecord = (v: unknown): v is LockRecord => {
  const r = v as Partial<LockRecord> | null;
  return r !== null && typeof r === 'object' && typeof r.token === 'string' && typeof r.hostname === 'string'
    && typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) && typeof r.heartbeatAt === 'number' && Number.isFinite(r.heartbeatAt);
};

function look(file: string): Look {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return unreadable(file);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { kind: 'record', rec: parsed };
  } catch { /* not json: an older lock file, or a hand-made one */ }
  return unreadable(file);
}

function unreadable(file: string): Look {
  try {
    return { kind: 'unreadable', mtimeMs: statSync(file).mtimeMs };
  } catch {
    return { kind: 'missing' };
  }
}

/** A heartbeat is compared on the injected clock; a file that holds none is aged by its mtime on the wall clock. */
const ageOf = (seen: Exclude<Look, { kind: 'missing' }>, now: () => number): number =>
  (seen.kind === 'record' ? now() - seen.rec.heartbeatAt : Date.now() - seen.mtimeMs);
const identity = (seen: Look): string => (seen.kind === 'record' ? `r:${seen.rec.token}:${seen.rec.heartbeatAt}` : seen.kind === 'unreadable' ? `u:${seen.mtimeMs}` : 'missing');
const busy = (seen: Look): RunLock => (seen.kind === 'record' ? { held: false, owner: seen.rec } : { held: false });

/** Create `target` holding `rec`, atomically and complete; false when it already exists. */
function tryCreate(target: string, rec: LockRecord): boolean {
  const candidate = `${target}.${rec.token}.tmp`;
  writeFileSync(candidate, `${JSON.stringify(rec)}\n`, { flag: 'wx' });
  try {
    try {
      linkSync(candidate, target);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return false;
      if (!LINK_UNSUPPORTED.has(code)) throw err;
    }
    // no hard links here: an exclusive create, then the record (a reader that meets it empty treats it as young and unreadable)
    let fd: number;
    try {
      fd = openSync(target, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
    try { writeSync(fd, `${JSON.stringify(rec)}\n`); } finally { closeSync(fd); }
    return true;
  } finally {
    try { unlinkSync(candidate); } catch { /* already gone */ }
  }
}

function removeIfOurs(file: string, token: string): void {
  const seen = look(file);
  if (seen.kind === 'record' && seen.rec.token === token) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

function heldLock(file: string, rec: LockRecord, now: () => number): RunLock {
  let current = rec;
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
  const heartbeat = (): boolean => {
    const seen = look(file);
    if (seen.kind !== 'record' || seen.rec.token !== rec.token) return false;
    current = { ...current, heartbeatAt: now() };
    const scratch = `${file}.${rec.token}.hb`;
    try {
      writeFileSync(scratch, `${JSON.stringify(current)}\n`);
      renameSync(scratch, file);
    } catch {
      // could not write this beat (a full disk, say): still ours, try again at the next one; the lease has a minute of slack
      try { unlinkSync(scratch); } catch { /* nothing to remove */ }
    }
    return true;
  };
  return {
    held: true,
    token: rec.token,
    heartbeat,
    startHeartbeat(onLost, everyMs = LOCK_HEARTBEAT_MS) {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (heartbeat()) return;
        stop();
        onLost();
      }, everyMs);
      timer.unref();
    },
    release() {
      stop();
      removeIfOurs(file, rec.token);
    },
  };
}

export function acquireRunLock(file: string, opts: LockOptions = {}): RunLock {
  const now = opts.now ?? Date.now;
  const t = now();
  const rec: LockRecord = { token: opts.token ?? randomUUID(), hostname: opts.hostname ?? os.hostname(), startedAt: t, heartbeatAt: t };
  const guard = `${file}.takeover`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryCreate(file, rec)) return heldLock(file, rec, now);
    const seen = look(file);
    if (seen.kind === 'missing') continue; // released or taken over between the create and the look: go round
    if (ageOf(seen, now) <= LOCK_STALE_MS) return busy(seen);

    // The lock is stale. Only the holder of the guard may remove it.
    if (!tryCreate(guard, rec)) {
      const held = look(guard);
      if (held.kind === 'missing') continue; // the guard was released between the failed create and the look: go round
      let age = 0;
      try { age = Date.now() - statSync(guard).mtimeMs; } catch { /* released just now */ }
      if (age > TAKEOVER_GUARD_STALE_MS) {
        try { unlinkSync(guard); } catch { /* another run removed it first */ }
        continue;
      }
      return busy(seen);
    }
    try {
      const again = look(file);
      if (again.kind !== 'missing') {
        // another run finished its takeover while this one waited for the guard: its lock is fresh, and it stays
        if (identity(again) !== identity(seen) || ageOf(again, now) <= LOCK_STALE_MS) return busy(again);
        try { unlinkSync(file); } catch { /* removed meanwhile */ }
      }
      if (tryCreate(file, rec)) return heldLock(file, rec, now);
      return busy(look(file)); // a plain creator slipped in after the removal: it holds
    } finally {
      removeIfOurs(guard, rec.token);
    }
  }
  return { held: false };
}
