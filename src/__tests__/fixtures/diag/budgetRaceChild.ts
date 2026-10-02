/**
 * Child process for diagBudgetRace.test.ts: opens its OWN handle on the shared queue sqlite, waits
 * for the common start instant, then spends as fast as it can. Prints one JSON line:
 * { charged, errors }.
 *
 * argv: <dir> <hostDailyCap> <startAtEpochMs> <calls>
 */
import { openDiagBudget } from '../../../diag/budget.js';
import { Probe } from '../../../gen/fc/diag/v1/diag_pb.js';

const [dir, capRaw, startAtRaw, callsRaw] = process.argv.slice(2);
const budget = openDiagBudget({ dir, hostDailyCap: Number(capRaw) });
const startAt = Number(startAtRaw);

// Sleep without spinning until just before the start, then spin the last few ms so every child
// begins inside the same millisecond window.
const lead = startAt - Date.now() - 5;
if (lead > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, lead);
while (Date.now() < startAt) {
  /* spin */
}

let charged = 0;
const errors: string[] = [];
for (let i = 0; i < Number(callsRaw); i++) {
  const call = budget.startCall({ probe: Probe.ITEM_STATUS, host: 'race.example', runId: `${process.pid}-${i}` });
  for (let k = 0; k < 2; k++) {
    try {
      if (call.charge()) charged++;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}
budget.close();
process.stdout.write(`${JSON.stringify({ charged, errors })}\n`);
