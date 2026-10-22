/**
 * Racing processes against ONE stale lock (red team R2-S2): the takeover was read, unlink, create, so two runs that started in the
 * same millisecond could both take it (17 of 40 trials with 4 racers). Real processes, spinning to the same millisecond, trial after
 * trial; every trial must end with EXACTLY ONE holder.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.setTimeout(180_000);

const REPO = path.resolve(__dirname, '../../..');
const RACER = 'src/__tests__/helpers/galleryLockRacer.ts';

type Line = { trial: number; racer: string; held: boolean };
async function race(dir: string, racers: number, trials: number): Promise<Line[]> {
  const startAt = Date.now() + 6_000; // tsx needs a few seconds to load in every child
  const runs = Array.from({ length: racers }, (_v, k) => new Promise<Line[]>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', RACER, dir, String(trials), String(startAt), '40', String(k)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('close', code => (code === 0 ? resolve(out.split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Line)) : reject(new Error(`racer ${k} exited ${code}: ${err.slice(-300)}`))));
  }));
  return (await Promise.all(runs)).flat();
}
const holders = (lines: Line[], trials: number): number[] => Array.from({ length: trials }, (_v, i) => lines.filter(l => l.trial === i && l.held).length);

describe('acquireRunLock under a race', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'gallery-lock-race-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  /** A stale lock in the shape of the first cut (a dead pid, an hour-old file) or of the lease (an hour-old heartbeat). */
  const stale = (trials: number, shape: 'legacy pid file' | 'lease record'): void => {
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < trials; i++) {
      const f = path.join(dir, `lock-${i}`);
      writeFileSync(f, shape === 'legacy pid file' ? '2147483000\n' : JSON.stringify({ token: 'dead', hostname: 'pod-a', startedAt: 1, heartbeatAt: 1 }));
      utimesSync(f, old, old);
    }
  };

  describe.each(['legacy pid file', 'lease record'] as const)('a stale lock written as a %s', shape => {
    it.each([[4, 60], [2, 60], [8, 40]])('%i racers, %i trials: exactly one holder every time', async (racers, trials) => {
      mkdirSync(dir, { recursive: true });
      stale(trials, shape);
      const h = holders(await race(dir, racers, trials), trials);
      expect(h.filter(n => n > 1)).toEqual([]);
      expect(h.filter(n => n === 0)).toEqual([]);
      expect(h.every(n => n === 1)).toBe(true);
    });
  });

  it('4 racers on a FREE lock, 40 trials: exactly one holder every time', async () => {
    const h = holders(await race(dir, 4, 40), 40);
    expect(h.every(n => n === 1)).toBe(true);
  });
});
