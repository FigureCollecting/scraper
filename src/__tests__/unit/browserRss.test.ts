import { parseProcStat, readProcessTreeRssBytes, type ProcReader } from '../../services/browserRss';

/**
 * The memory trigger replaces a timer, so it has to be right about two things: parsing a file whose
 * second field can contain the very characters you would split on, and summing a TREE rather than
 * one process — Chrome's growth lands in renderers, not in the browser process that spawned them.
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
});
