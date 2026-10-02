/**
 * TDD (red first) — the diag budget under REAL concurrency (hands-off plan unit S1).
 *
 * The unit tests prove a single process cannot overspend. This one starts four separate processes,
 * each with its own sqlite connection to the same file, and lets them race for one host's budget at
 * the same instant. Far more charges are attempted than the cap allows; exactly the cap may succeed,
 * none may fail with a lock error, and the table must hold exactly the cap.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openDiagBudget } from '../../diag/budget';
import { QUEUE_DB_FILE } from '../../services/queueStore';

const REPO = path.resolve(__dirname, '../../..');
const CHILD = path.join(__dirname, '../fixtures/diag/budgetRaceChild.ts');

function runChild(args: string[]): Promise<{ charged: number; errors: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() ?? ''));
      } catch (e) {
        reject(new Error(`child printed no result: ${out} ${err} ${String(e)}`));
      }
    });
  });
}

describe('diag budget — four processes racing for one host', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-budget-race-'));
    // Create the table up front so the children race on charges, not on the schema.
    openDiagBudget({ dir, hostDailyCap: 1 }).close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('charges exactly the cap across processes, with no lock errors', async () => {
    const cap = 24;
    const startAt = Date.now() + 4_000;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runChild([dir, String(cap), String(startAt), '40']))
    );
    const charged = results.reduce((a, r) => a + r.charged, 0);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(charged).toBe(cap);
    const db = new DatabaseSync(path.join(dir, QUEUE_DB_FILE), { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM diag_budget WHERE host = 'race.example'").get() as { n: number };
      expect(row.n).toBe(cap);
    } finally {
      db.close();
    }
  }, 60_000);
});
