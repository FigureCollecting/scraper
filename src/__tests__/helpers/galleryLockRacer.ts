/**
 * One racer for galleryLock.race.test.ts (run as `node --import tsx galleryLockRacer.ts <dir> <trials> <startAtMs> <stepMs> <mode>`):
 * for each trial it spins to the SAME millisecond as its sibling processes, then calls acquireRunLock on that trial's lock file and
 * prints one JSON line {trial, held, token}. It never releases: whoever holds a lock keeps it, so a second holder is visible.
 */
import path from 'node:path';
import { acquireRunLock } from '../../services/images/galleryLock.js';

const [dir, trials, startAt, step] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
const racer = process.argv[6] ?? String(process.pid);
const results: string[] = [];
for (let i = 0; i < trials; i++) {
  const target = startAt + i * step;
  while (Date.now() < target) { /* spin to the same millisecond as the other racers */ }
  const lock = acquireRunLock(path.join(dir, `lock-${i}`), { token: `racer-${racer}-${i}`, hostname: `host-${racer}` });
  results.push(JSON.stringify({ trial: i, racer, held: lock.held }));
}
process.stdout.write(`${results.join('\n')}\n`);
