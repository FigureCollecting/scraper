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
 * MEASURE PSS, NOT RSS — the 2026-09-11 22:31–22:41 incident. The first cut of this module summed
 * `VmRSS` over the tree, and VmRSS COUNTS EVERY SHARED PAGE ONCE PER PROCESS: Chrome's renderers,
 * GPU process and utility processes all map the same binary, the same shared libraries and the same
 * /dev/shm segments (a 2 GiB emptyDir in this pod), so the sum is not a quantity of memory at all.
 * Measured on fc-app-01 the same nine-process tree reads
 *
 *     VmRSS-sum 815 MiB   vs   PSS-sum 217 MiB   —   a 3.76x overstatement
 *
 * against a 1 GiB trigger, i.e. the trigger really fired at a ~272 MiB footprint. It fired within
 * seconds of every launch, and the residential lane relaunched eight times in ten minutes, spending
 * a prime navigation on a Cloudflare-fronted store each time — the exact session churn the evidence
 * trigger was built to END.
 *
 * PSS (Proportional Set Size) is the additive one: a page shared by N processes charges each of them
 * 1/N of it, so summing PSS across a set of processes reconstructs what that set actually costs the
 * cgroup. That is precisely the question "does this browser deserve to be recycled?" is asking.
 *
 * Read it from `/proc/<pid>/smaps_rollup` (one cheap line per process; kernel ≥ 4.14), falling back
 * to summing `/proc/<pid>/smaps` (same numbers, many more lines), and only then to VmRSS from
 * `/proc/<pid>/stat` — which is flagged as `rss-fallback` on /health so an operator can see that the
 * number in front of them is the overstating one.
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

/**
 * How a tree's memory was actually measured. Reported on /health because the three answers are not
 * interchangeable: the first two are the real proportional footprint, the third overstates it by
 * whatever Chrome happens to be sharing (3.76x when this was measured on fc-app-01).
 */
export type MemoryMeasureMethod = 'pss-rollup' | 'pss-smaps' | 'rss-fallback';

/** A measured process tree: what it costs, how that was learned, and over how many processes. */
export interface ProcessTreeMemory {
  bytes: number;
  method: MemoryMeasureMethod;
  processes: number;
}

/**
 * The filesystem surface the walk needs (injected; the default reads the real /proc).
 *
 * The two smaps readers are OPTIONAL so a caller with only `readStat` still works and degrades,
 * visibly, to `rss-fallback` — which is also what happens on a kernel with no smaps_rollup.
 */
export interface ProcReader {
  listPids(): Promise<number[]>;
  readStat(pid: number): Promise<string | undefined>;
  readSmapsRollup?(pid: number): Promise<string | undefined>;
  readSmaps?(pid: number): Promise<string | undefined>;
}

/**
 * Linux reports RSS in pages and every platform this runs on uses 4 KiB. Hard-coded deliberately:
 * the alternative is shelling out to `getconf PAGESIZE` on a path that must stay cheap, and being
 * wrong by a constant factor on an exotic kernel is a tuning problem, not a correctness one.
 */
const PAGE_SIZE_BYTES = 4096;

/** Weakest-wins ordering: a tree is only as trustworthy as its least trustworthy member. */
const METHOD_WEAKNESS: Record<MemoryMeasureMethod, number> = {
  'pss-rollup': 0,
  'pss-smaps': 1,
  'rss-fallback': 2,
};

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
 * Sum the `Pss:` lines of an smaps or smaps_rollup body, in kB.
 *
 * ANCHORED ON EXACTLY `Pss:` — a rollup also carries `Pss_Dirty:`, `Pss_Anon:` and `Pss_File:`,
 * which are BREAKDOWNS of that same total. A looser match would add the total to its own parts and
 * roughly triple the answer, which on this code path means relaunching a healthy browser.
 *
 * `undefined` means the body carried no Pss at all (an empty read, a kernel without it, a process
 * that exited mid-read) — no evidence, never zero.
 */
export function parsePssKb(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const match = /^Pss:[ \t]+(\d+)[ \t]+kB/.exec(line);
    if (!match) continue;
    total += Number(match[1]);
    found = true;
  }
  return found ? total : undefined;
}

/** Every pid in `rootPid`'s subtree, with the stat entries already parsed. */
async function collectTree(rootPid: number, reader: ProcReader): Promise<Map<number, ProcEntry> | undefined> {
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
  const members = new Map<number, ProcEntry>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (members.has(pid)) continue;
    const entry = entries.get(pid);
    if (!entry) continue;
    members.set(pid, entry);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return members;
}

/** One process's proportional footprint in kB, by the best method its /proc will answer. */
async function readPidMemoryKb(
  pid: number,
  entry: ProcEntry,
  reader: ProcReader,
): Promise<{ kb: number; method: MemoryMeasureMethod }> {
  const rollup = await reader.readSmapsRollup?.(pid).catch(() => undefined);
  if (rollup !== undefined) {
    const kb = parsePssKb(rollup);
    if (kb !== undefined) return { kb, method: 'pss-rollup' };
  }
  const smaps = await reader.readSmaps?.(pid).catch(() => undefined);
  if (smaps !== undefined) {
    const kb = parsePssKb(smaps);
    if (kb !== undefined) return { kb, method: 'pss-smaps' };
  }
  return { kb: (entry.rssPages * PAGE_SIZE_BYTES) / 1024, method: 'rss-fallback' };
}

/**
 * What `rootPid` and every descendant of it actually cost, proportionally.
 *
 * `undefined` means NO EVIDENCE — the root process is gone, /proc is unreadable, or this is not
 * Linux. A caller must not treat that as a small number: recycling a browser because its memory
 * could not be measured is exactly the timer behaviour this replaces.
 *
 * Races are benign by construction: a process that exits mid-walk simply drops out of the sum, and
 * one that appears is attributed on the next sample. The answer is a sample, not a transaction.
 */
export async function readProcessTreeMemory(
  rootPid: number,
  reader: ProcReader = procReader(),
): Promise<ProcessTreeMemory | undefined> {
  const members = await collectTree(rootPid, reader);
  if (!members) return undefined;

  let kb = 0;
  let method: MemoryMeasureMethod = 'pss-rollup';
  // Sequential on purpose: smaps reads are per-process file reads and a wide Chrome tree would
  // otherwise open a dozen at once on a path whose whole justification is that it is cheap.
  for (const [pid, entry] of members) {
    const measured = await readPidMemoryKb(pid, entry, reader);
    kb += measured.kb;
    if (METHOD_WEAKNESS[measured.method] > METHOD_WEAKNESS[method]) method = measured.method;
  }
  return { bytes: kb * 1024, method, processes: members.size };
}

/**
 * Resident bytes held by `rootPid` and every descendant — the VmRSS sum, kept for callers that want
 * the raw kernel number. NOT the trigger input: see the PSS note at the top of this file for why
 * summing VmRSS over a Chrome tree overstates it by roughly 3.8x.
 */
export async function readProcessTreeRssBytes(rootPid: number, reader: ProcReader = procReader()): Promise<number | undefined> {
  const members = await collectTree(rootPid, reader);
  if (!members) return undefined;
  let total = 0;
  for (const entry of members.values()) total += entry.rssPages * PAGE_SIZE_BYTES;
  return total;
}

/** The real /proc reader. Absent /proc (macOS, Windows, a test) every read answers `undefined`. */
export function procReader(): ProcReader {
  const readText = async (path: string): Promise<string | undefined> => {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf8').catch(() => undefined);
  };
  return {
    async listPids(): Promise<number[]> {
      const { readdir } = await import('node:fs/promises');
      const names = await readdir('/proc').catch(() => [] as string[]);
      return names.filter((name) => /^\d+$/.test(name)).map(Number);
    },
    readStat: (pid: number) => readText(`/proc/${pid}/stat`),
    readSmapsRollup: (pid: number) => readText(`/proc/${pid}/smaps_rollup`),
    readSmaps: (pid: number) => readText(`/proc/${pid}/smaps`),
  };
}

/** Where a container's memory ceiling is published: cgroup v2 first, then v1. */
export const CGROUP_MEMORY_LIMIT_PATHS = [
  '/sys/fs/cgroup/memory.max',
  '/sys/fs/cgroup/memory/memory.limit_in_bytes',
];

/** The file surface the cgroup read needs (injected so tests never touch a real /sys). */
export interface CgroupReader {
  read(path: string): Promise<string | undefined>;
}

/**
 * The memory ceiling this process actually runs under, so the relaunch threshold can be a FRACTION
 * of the real budget rather than a constant that happened to suit one pod.
 *
 * `undefined` for every way of not knowing, and they all matter:
 *   - cgroup v2 writes the literal `max` when unlimited;
 *   - cgroup v1 writes a near-2^63 sentinel, which is not a safe integer and is rejected as such;
 *   - no cgroup at all (a laptop, a test) leaves both paths unreadable.
 * A caller that read any of those as a number would derive a nonsense threshold from it.
 */
export async function readCgroupMemoryLimitBytes(reader: CgroupReader = cgroupReader()): Promise<number | undefined> {
  for (const path of CGROUP_MEMORY_LIMIT_PATHS) {
    const raw = await reader.read(path).catch(() => undefined);
    if (raw === undefined) continue;
    const text = raw.trim();
    if (text === '' || text === 'max') continue;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    return value;
  }
  return undefined;
}

/** The real /sys reader. */
export function cgroupReader(): CgroupReader {
  return {
    async read(path: string): Promise<string | undefined> {
      const { readFile } = await import('node:fs/promises');
      return await readFile(path, 'utf8').catch(() => undefined);
    },
  };
}
