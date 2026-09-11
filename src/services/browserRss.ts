/**
 * browserRss — how much memory one Chrome is actually using, so the challenge lane can recycle a
 * browser on the EVIDENCE of growth rather than on a timer that stands in for it.
 *
 * WHY THIS EXISTS: a cleared Cloudflare session is an asset. It is bound to the egress IP, the TLS
 * fingerprint and the user agent, it took ~9 s of challenge to earn, and every replacement pays for
 * it again from an IP whose reputation those challenges spend. The two-hour recycle was never about
 * time — the comment on GATED_BROWSER_MAX_AGE_MS says so plainly ("an immortal Chrome is the leak
 * shape this engine has already paid for once"). It was a crude proxy for "this renderer is
 * growing". The quantity it proxies is directly readable, so read it.
 *
 * `process.memoryUsage()` cannot answer: that is the Node process, and Chrome is a process TREE —
 * a browser process plus one renderer per tab, which is where the growth actually lands. So walk
 * /proc, which is the only place this is knowable on Linux, and sum the subtree.
 *
 * Every reader is injected, so the unit tests never touch a real /proc and this module stays honest
 * on a platform that has none (it answers `undefined`, which callers must read as "no evidence",
 * never as "zero").
 */

/** The bits of a process's /proc entry this needs: who its parent is, and its resident pages. */
interface ProcEntry {
  ppid: number;
  rssPages: number;
}

/** The filesystem surface the walk needs (injected; the default reads the real /proc). */
export interface ProcReader {
  listPids(): Promise<number[]>;
  readStat(pid: number): Promise<string | undefined>;
}

/**
 * Linux reports RSS in pages and every platform this runs on uses 4 KiB. Hard-coded deliberately:
 * the alternative is shelling out to `getconf PAGESIZE` on a path that must stay cheap, and being
 * wrong by a constant factor on an exotic kernel is a tuning problem, not a correctness one.
 */
const PAGE_SIZE_BYTES = 4096;

/**
 * Parse one `/proc/<pid>/stat` line. The comm field is parenthesised and MAY CONTAIN SPACES AND
 * PARENTHESES, which is why this splits after the LAST `)` rather than on whitespace — the classic
 * way to misparse this file. After that field, fields are 1-indexed from `state`: ppid is the 2nd,
 * rss the 22nd.
 */
export function parseProcStat(line: string): ProcEntry | undefined {
  const close = line.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = line.slice(close + 1).trim().split(/\s+/);
  // fields[0] = state, fields[1] = ppid, … fields[21] = rss (pages)
  const ppid = Number(fields[1]);
  const rssPages = Number(fields[21]);
  if (!Number.isFinite(ppid) || !Number.isFinite(rssPages)) return undefined;
  return { ppid, rssPages };
}

/**
 * Resident bytes held by `rootPid` and every descendant of it.
 *
 * `undefined` means NO EVIDENCE — the root process is gone, /proc is unreadable, or this is not
 * Linux. A caller must not treat that as a small number: recycling a browser because its memory
 * could not be measured is exactly the timer behaviour this replaces.
 *
 * Races are benign by construction: a process that exits mid-walk simply drops out of the sum, and
 * one that appears is attributed on the next sample. The answer is a sample, not a transaction.
 */
export async function readProcessTreeRssBytes(rootPid: number, reader: ProcReader = procReader()): Promise<number | undefined> {
  const rootStat = await reader.readStat(rootPid);
  if (rootStat === undefined) return undefined;
  const root = parseProcStat(rootStat);
  if (!root) return undefined;

  const pids = await reader.listPids().catch(() => []);
  const entries = new Map<number, ProcEntry>([[rootPid, root]]);
  await Promise.all(pids.map(async (pid) => {
    if (pid === rootPid) return;
    const line = await reader.readStat(pid);
    if (line === undefined) return;
    const entry = parseProcStat(line);
    if (entry) entries.set(pid, entry);
  }));

  const children = new Map<number, number[]>();
  for (const [pid, entry] of entries) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(pid);
    else children.set(entry.ppid, [pid]);
  }

  // Breadth-first over the subtree, with a seen-set: /proc can hand back a parent cycle when pids
  // are reused mid-walk, and an unguarded walk would spin on it.
  let total = 0;
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = entries.get(pid);
    if (!entry) continue;
    total += entry.rssPages * PAGE_SIZE_BYTES;
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return total;
}

/** The real /proc reader. Absent /proc (macOS, Windows, a test) every read answers `undefined`. */
export function procReader(): ProcReader {
  return {
    async listPids(): Promise<number[]> {
      const { readdir } = await import('node:fs/promises');
      const names = await readdir('/proc').catch(() => [] as string[]);
      return names.filter((name) => /^\d+$/.test(name)).map(Number);
    },
    async readStat(pid: number): Promise<string | undefined> {
      const { readFile } = await import('node:fs/promises');
      return await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
    },
  };
}
