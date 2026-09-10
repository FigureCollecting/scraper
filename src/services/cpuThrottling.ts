/**
 * cpuThrottling — whether the KERNEL is holding this process off the CPU.
 *
 * The raw-capture sink reports every store latency as wall clock measured inside this
 * process, so a pod that is not being SCHEDULED reports a slow bucket. `eventLoopLagP95`
 * / `eventLoopLagMax` narrow that to "this process was slow", but they cannot say why: a
 * long synchronous parse and a cgroup CPU quota produce the same lag.
 *
 * cgroup v2 keeps the direct answer in `cpu.stat`. `nr_throttled` counts the scheduling
 * periods in which the cgroup was stopped after exhausting its quota, and
 * `throttled_usec` the microseconds it spent stopped — kernel counters, not samples, so
 * there is no window or percentile for a burst to hide behind. Read beside the lag they
 * separate "we are doing too much work" from "we are not being given the CPU to do it",
 * which is the difference between a code fix and a limits change.
 *
 * The counters are CUMULATIVE for the life of the cgroup, which is why the read is
 * stamped: a single value says almost nothing, and two polls minus each other say
 * everything. Absent entirely off cgroup v2 (dev boxes, macOS, CI), and the throttle
 * fields are absent on a cgroup with no `cpu.max` limit — which is "no quota", not
 * "no throttling observed", so they are left undefined rather than reported as zero.
 */
import { readFileSync } from 'node:fs';

/** The default cgroup v2 path inside a container: the pod's own cgroup is mounted at root. */
export const CGROUP_V2_CPU_STAT = '/sys/fs/cgroup/cpu.stat';

export interface CpuThrottlingView {
  /** false where there is no cgroup v2 `cpu.stat` to read at all. */
  available: boolean;
  /** Scheduling periods elapsed. Absent unless a CPU limit is set on the cgroup. */
  nrPeriods?: number;
  /** Of those, the periods the cgroup was stopped having spent its quota. */
  nrThrottled?: number;
  /** Microseconds spent stopped. Cumulative, like the counts. */
  throttledUsec?: number;
  /** When these were read — the counters are cumulative, so an operator diffs two polls. */
  readAt?: string;
}

/** A whitespace-separated `key value` line, where the value parses as a finite number. */
function numeric(lines: Map<string, string>, key: string): number | undefined {
  const raw = lines.get(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the cgroup's CPU throttling counters. NEVER throws: this is read by the health
 * route, and a health endpoint that 500s on an optional diagnostic is worse than one
 * that omits it.
 */
export function readCpuThrottling(path: string = CGROUP_V2_CPU_STAT): CpuThrottlingView {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return { available: false };
  }
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (key && value !== undefined) fields.set(key, value);
  }
  return {
    available: true,
    nrPeriods: numeric(fields, 'nr_periods'),
    nrThrottled: numeric(fields, 'nr_throttled'),
    throttledUsec: numeric(fields, 'throttled_usec'),
    readAt: new Date().toISOString(),
  };
}

/** The ops-readable view for /health/detailed. Never throws. */
export function cpuThrottlingView(path?: string): CpuThrottlingView {
  try {
    return readCpuThrottling(path);
  } catch {
    return { available: false };
  }
}
