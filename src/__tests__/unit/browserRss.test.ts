import {
  parsePssKb,
  parseProcStat,
  readCgroupMemoryLimitBytes,
  readProcessTreeMemory,
  readProcessTreeRssBytes,
  type CgroupReader,
  type ProcReader,
} from '../../services/browserRss';

/**
 * The memory trigger replaces a timer, so it has to be right about three things: parsing a file
 * whose second field can contain the very characters you would split on, summing a TREE rather than
 * one process — Chrome's growth lands in renderers, not in the browser process that spawned them —
 * and summing the PROPORTIONAL figure rather than the resident one.
 *
 * That third point is the 2026-09-11 incident. VmRSS counts every shared page once PER PROCESS, and
 * Chrome's renderers, GPU and utility processes all map the same binary, the same libraries and the
 * same /dev/shm. Summing it over a tree is not a quantity of memory at all.
 */
describe('browserRss', () => {
  const PAGE = 4096;
  /** `/proc/<pid>/stat` as the kernel writes it: pid, (comm), state, ppid, … rss is the 22nd after comm. */
  const stat = (pid: number, comm: string, ppid: number, rssPages: number): string => {
    const after = ['S', String(ppid)];
    while (after.length < 21) after.push('0');
    after.push(String(rssPages));
    return `${pid} (${comm}) ${after.join(' ')}\n`;
  };

  const readerFor = (rows: Array<[number, string, number, number]>): ProcReader => ({
    listPids: async () => rows.map(([pid]) => pid),
    readStat: async (pid: number) => {
      const row = rows.find(([candidate]) => candidate === pid);
      return row ? stat(row[0], row[1], row[2], row[3]) : undefined;
    },
  });

  /**
   * THE CLASSIC MISPARSE. Chrome's own processes are named things like `(chrome (renderer))`, and a
   * whitespace split puts the state field where ppid belongs — quietly attributing every renderer to
   * the wrong parent and reporting a browser as using nothing.
   */
  it('parses a comm field containing spaces and parentheses', () => {
    expect(parseProcStat(stat(7, 'chrome (renderer) x', 3, 100))).toEqual({ ppid: 3, rssPages: 100 });
  });

  it('answers undefined for a line with no comm field at all', () => {
    expect(parseProcStat('garbage')).toBeUndefined();
  });

  it('answers undefined for a line whose numeric fields are not numbers', () => {
    expect(parseProcStat('7 (chrome) S notapid')).toBeUndefined();
  });

  it('sums the browser process and every descendant, not just the root', async () => {
    const reader = readerFor([
      [100, 'chrome', 1, 10],       // the browser process
      [101, 'chrome (renderer)', 100, 20],
      [102, 'chrome (gpu)', 100, 30],
      [103, 'chrome (renderer)', 101, 40], // a grandchild still belongs to this browser
      [200, 'node', 1, 999],              // another tree entirely — must NOT be counted
    ]);

    expect(await readProcessTreeRssBytes(100, reader)).toBe((10 + 20 + 30 + 40) * PAGE);
  });

  /** `undefined` is NO EVIDENCE. A caller that read it as zero would never recycle a leaking lane. */
  it('answers undefined when the browser process is gone', async () => {
    expect(await readProcessTreeRssBytes(999, readerFor([[100, 'chrome', 1, 10]]))).toBeUndefined();
  });

  it('answers undefined when the root stat is unparseable', async () => {
    const reader: ProcReader = { listPids: async () => [100], readStat: async () => 'garbage' };
    expect(await readProcessTreeRssBytes(100, reader)).toBeUndefined();
  });

  it('survives a listing it cannot read, reporting the root alone', async () => {
    const reader: ProcReader = {
      listPids: async () => { throw new Error('/proc unreadable'); },
      readStat: async (pid: number) => (pid === 100 ? stat(100, 'chrome', 1, 10) : undefined),
    };
    expect(await readProcessTreeRssBytes(100, reader)).toBe(10 * PAGE);
  });

  /** A pid-reuse race can hand back a parent cycle; an unguarded walk would spin on it forever. */
  it('terminates on a parent cycle instead of spinning', async () => {
    const reader = readerFor([[100, 'chrome', 101, 10], [101, 'chrome', 100, 20]]);
    expect(await readProcessTreeRssBytes(100, reader)).toBe(30 * PAGE);
  });

  describe('PSS parsing', () => {
    /**
     * THE TRAP THAT WOULD TRIPLE THE ANSWER. `smaps_rollup` reports the Pss total and then breaks it
     * down as Pss_Dirty / Pss_Anon / Pss_File. A looser match adds the total to its own parts.
     */
    it('sums only the Pss total, never its Pss_Dirty / Pss_Anon / Pss_File breakdown', () => {
      const rollup = [
        '00400000-7ffc0dde5000 ---p 00000000 00:00 0                              [rollup]',
        'Rss:              132184 kB',
        'Pss:              129438 kB',
        'Pss_Dirty:         76216 kB',
        'Pss_Anon:          76216 kB',
        'Pss_File:          53222 kB',
        'Shared_Clean:       5492 kB',
        '',
      ].join('\n');

      expect(parsePssKb(rollup)).toBe(129438);
    });

    /** A full `smaps` has one Pss line per mapping; the process's figure is their sum. */
    it('sums every mapping in a full smaps body', () => {
      const smaps = [
        '55a1-55a2 r-xp 00000000 fd:00 1 /opt/chrome',
        'Pss:                 100 kB',
        '55a3-55a4 rw-p 00000000 00:00 0',
        'Pss:                  25 kB',
        '',
      ].join('\n');

      expect(parsePssKb(smaps)).toBe(125);
    });

    it('answers undefined for a body carrying no Pss at all', () => {
      expect(parsePssKb('Rss:   100 kB\nSwap:   0 kB\n')).toBeUndefined();
      expect(parsePssKb('')).toBeUndefined();
    });
  });

  describe('proportional tree measurement', () => {
    /**
     * THE PRODUCTION FIXTURE. These are the real numbers from fc-app-01 on 2026-09-11: one gated
     * Chrome, nine processes. Summing VmRSS reads 815 MiB and trips a 1 GiB trigger the moment two
     * more renderers open; summing PSS reads 217 MiB, which is what the browser actually costs.
     *
     * A regression that goes back to VmRSS fails HERE, on the exact shape that caused eight
     * relaunches in ten minutes.
     */
    const POD_TREE: Array<[pid: number, ppid: number, rssKb: number, pssKb: number]> = [
      [18, 1, 199228, 81908],
      [25, 18, 71468, 14385],
      [26, 18, 71420, 9841],
      [60, 18, 121044, 33038],
      [145, 25, 75084, 21843],
      [104, 26, 74316, 14721],
      [113, 26, 99092, 23777],
      [129, 26, 74128, 14843],
      [61, 26, 49096, 7427],
    ];
    const OTHER_TREE: Array<[number, number, number, number]> = [[900, 1, 500000, 400000]];

    const podReader = (overrides: Partial<ProcReader> = {}): ProcReader => {
      const rows = [...POD_TREE, ...OTHER_TREE];
      return {
        listPids: async () => rows.map(([pid]) => pid),
        readStat: async (pid: number) => {
          const row = rows.find(([candidate]) => candidate === pid);
          return row ? stat(row[0], 'chrome', row[1], Math.round((row[2] * 1024) / PAGE)) : undefined;
        },
        readSmapsRollup: async (pid: number) => {
          const row = rows.find(([candidate]) => candidate === pid);
          return row ? `[rollup]\nRss: ${row[2]} kB\nPss: ${row[3]} kB\nPss_Anon: ${row[3]} kB\n` : undefined;
        },
        ...overrides,
      };
    };

    const sumKb = (index: 2 | 3): number => POD_TREE.reduce((total, row) => total + row[index], 0);

    it('sums PSS over the tree, not VmRSS — 217 MiB where VmRSS reads 815 MiB', async () => {
      const measured = await readProcessTreeMemory(18, podReader());

      expect(measured).toEqual({ bytes: sumKb(3) * 1024, method: 'pss-rollup', processes: 9 });
      // The number the first cut of this module would have produced, and why it misfired.
      const rssBytes = await readProcessTreeRssBytes(18, podReader());
      expect(rssBytes).toBeGreaterThan(measured!.bytes * 3.5);
      expect(Math.round(measured!.bytes / (1024 * 1024))).toBe(217);
      expect(Math.round(sumKb(2) / 1024)).toBe(815);
    });

    it('excludes a process tree that is not this browser', async () => {
      const measured = await readProcessTreeMemory(18, podReader());
      expect(measured!.processes).toBe(POD_TREE.length);
      expect(measured!.bytes).toBeLessThan((sumKb(3) + 400000) * 1024);
    });

    /** A kernel without smaps_rollup still has smaps; the answer is the same, the method is not. */
    it('falls back to a full smaps read, flagging the method it used', async () => {
      const reader = podReader({
        readSmapsRollup: async () => undefined,
        readSmaps: async (pid: number) => {
          const row = [...POD_TREE, ...OTHER_TREE].find(([candidate]) => candidate === pid);
          return row ? `map-a\nPss: ${row[3] - 1} kB\nmap-b\nPss: 1 kB\n` : undefined;
        },
      });

      const measured = await readProcessTreeMemory(18, reader);
      expect(measured).toEqual({ bytes: sumKb(3) * 1024, method: 'pss-smaps', processes: 9 });
    });

    /**
     * With neither smaps file the only number left is VmRSS, and it OVERSTATES. Answering it is
     * better than answering nothing, but it must announce itself so /health can say so too.
     */
    it('falls back to VmRSS only as a last resort, and says so', async () => {
      const measured = await readProcessTreeMemory(18, readerFor(
        [...POD_TREE, ...OTHER_TREE].map(([pid, ppid, rssKb]) => [pid, 'chrome', ppid, Math.round((rssKb * 1024) / PAGE)] as [number, string, number, number]),
      ));

      expect(measured!.method).toBe('rss-fallback');
      expect(Math.round(measured!.bytes / (1024 * 1024))).toBe(815);
    });

    /** A tree is only as trustworthy as its least trustworthy member. */
    it('reports the WEAKEST method any process in the tree needed', async () => {
      const reader = podReader({
        readSmapsRollup: async (pid: number) => {
          if (pid === 60) return undefined; // one renderer refuses
          const row = POD_TREE.find(([candidate]) => candidate === pid);
          return row ? `[rollup]\nPss: ${row[3]} kB\n` : undefined;
        },
        readSmaps: async () => undefined,
      });

      const measured = await readProcessTreeMemory(18, reader);
      expect(measured!.method).toBe('rss-fallback');
    });

    it('answers undefined when the browser process is gone', async () => {
      expect(await readProcessTreeMemory(999, podReader())).toBeUndefined();
    });

    /** A reader that throws is no evidence either — it must not take the caller down with it. */
    it('survives a smaps read that throws, degrading to the next method', async () => {
      const reader = podReader({
        readSmapsRollup: async () => { throw new Error('EACCES'); },
        readSmaps: async () => { throw new Error('EACCES'); },
      });

      const measured = await readProcessTreeMemory(18, reader);
      expect(measured!.method).toBe('rss-fallback');
    });
  });

  describe('cgroup memory limit', () => {
    const reader = (files: Record<string, string>): CgroupReader => ({
      read: async (path: string) => files[path],
    });

    it('reads the cgroup v2 ceiling', async () => {
      expect(await readCgroupMemoryLimitBytes(reader({ '/sys/fs/cgroup/memory.max': '3221225472\n' })))
        .toBe(3 * 1024 * 1024 * 1024);
    });

    it('falls back to the cgroup v1 path', async () => {
      expect(await readCgroupMemoryLimitBytes(reader({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '2147483648' })))
        .toBe(2 * 1024 * 1024 * 1024);
    });

    /** v2 writes the literal `max` when unlimited; a Number() of it is NaN, not a ceiling. */
    it('answers undefined for an unlimited v2 cgroup', async () => {
      expect(await readCgroupMemoryLimitBytes(reader({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeUndefined();
    });

    /** v1 writes a near-2^63 sentinel, which is not a safe integer and must not become a threshold. */
    it('answers undefined for the cgroup v1 unlimited sentinel', async () => {
      expect(await readCgroupMemoryLimitBytes(reader({
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      }))).toBeUndefined();
    });

    it('answers undefined when no cgroup file is readable at all', async () => {
      expect(await readCgroupMemoryLimitBytes(reader({}))).toBeUndefined();
      expect(await readCgroupMemoryLimitBytes({ read: async () => { throw new Error('nope'); } })).toBeUndefined();
    });
  });
});
