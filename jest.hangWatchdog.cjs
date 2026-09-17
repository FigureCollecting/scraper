'use strict';

/**
 * Hang watchdog — fails a stalled run fast, and names what it stalled on.
 *
 * A jest worker can wedge without dying: the parent keeps waiting, `forceExit` is
 * never reached (it only runs once the RUN completes), and nothing is printed,
 * because with `verbose` a suite's output is only flushed when the suite finishes.
 * On GitHub that silence runs to the 6-hour job cap, and the runner it holds is one
 * the rest of the queue cannot have. It happened five times between 2026-09-11 and
 * 2026-09-15 — ~30 runner-hours, plus one unrelated run that sat queued 6.5 h behind
 * them — and left no evidence at all about which suite was stuck.
 *
 * So: watch the time since the last test FILE completed, not the run's total wall
 * time. A run that is merely slow keeps resetting the clock; a wedged worker does
 * not. When the clock expires, print every file still in flight (which is the one
 * piece of evidence the hung runs never produced) and exit non-zero.
 *
 * Armed on CI only, so a local `--watch` session or a debugger breakpoint is never
 * killed. `JEST_HANG_WATCHDOG_MS` overrides the threshold; `0` disables it.
 */

/** Longest observed gap between two file completions is ~40 s; this is ~9x that. */
const DEFAULT_IDLE_MS = 6 * 60 * 1000;

function positiveNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

class HangWatchdogReporter {
  constructor(_globalConfig, options = {}) {
    const raw = process.env.JEST_HANG_WATCHDOG_MS;
    const override = positiveNumber(raw);
    // An explicit 0 disables; an explicit positive value arms it anywhere (that is
    // how you reproduce this locally); otherwise it is a CI-only safety net.
    this._enabled = raw === '0' ? false : override !== undefined || Boolean(process.env.CI);
    this._idleMs = override ?? positiveNumber(options.idleMs) ?? DEFAULT_IDLE_MS;
    this._inFlight = new Map(); // test file path -> started at (ms)
    this._completed = 0;
    this._total = 0;
    this._timer = undefined;
  }

  onRunStart(aggregatedResult) {
    this._total = aggregatedResult?.numTotalTestSuites ?? 0;
    this._rearm();
  }

  onTestFileStart(test) {
    if (test?.path && !this._inFlight.has(test.path)) this._inFlight.set(test.path, Date.now());
    this._rearm();
  }

  onTestFileResult(test) {
    if (test?.path) this._inFlight.delete(test.path);
    this._completed += 1;
    this._rearm();
  }

  // Jest still emits the pre-30 names too; keying everything by path keeps the
  // bookkeeping idempotent whichever pair a given jest version calls.
  onTestStart(test) {
    this.onTestFileStart(test);
  }

  onTestResult(test) {
    this.onTestFileResult(test);
  }

  onRunComplete() {
    this._disarm();
  }

  _rearm() {
    if (!this._enabled) return;
    this._disarm();
    this._timer = setTimeout(() => this._fire(), this._idleMs);
    // Instrumentation must never be the reason the process stays alive. An unref'd
    // timer still fires while the run is hung, because the worker IPC channels are
    // what hold the loop open.
    this._timer.unref?.();
  }

  _disarm() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
  }

  _fire() {
    const idleSeconds = Math.round(this._idleMs / 1000);
    const lines = [
      '',
      '=== JEST HANG WATCHDOG ===',
      `No test file has completed in ${idleSeconds}s. Treating the run as hung.`,
      `Completed ${this._completed} of ${this._total} test files.`,
    ];

    if (this._inFlight.size === 0) {
      lines.push('No test file is in flight — the run stalled between files (scheduling, transform or teardown).');
    } else {
      lines.push(`${this._inFlight.size} test file(s) still in flight:`);
      for (const [path, startedAt] of this._inFlight) {
        lines.push(`  ${Math.round((Date.now() - startedAt) / 1000)}s  ${path}`);
      }
    }
    lines.push('==========================', '');

    process.stderr.write(`${lines.join('\n')}\n`);
    // Nothing else is going to end this run: the workers are not dead, so jest will
    // not give up, and forceExit never runs because the run never completes.
    process.exit(1);
  }
}

module.exports = HangWatchdogReporter;
