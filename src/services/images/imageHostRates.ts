/**
 * imageHostRates — how fast we may fetch from ONE image host, as operator config.
 *
 * The image lane's limiter (`assembleImageCapture.ts`) knows no host: an unmapped CDN gets the limiter's own
 * default, a 2,067 ms gap that eases toward 274 ms after a few successes. That is right for a shared CDN
 * nobody has measured and wrong for a host somebody decided a rate for. `IMAGE_HOST_RATE_JSON` is that decision:
 *
 *   IMAGE_HOST_RATE_JSON='{"images.example.net":{"intervalMs":1000}}'
 *
 * A row pins the host's gap — its base AND its floor — so a run of successes never speeds the host up; a
 * 429/503 still backs it off (x1.4, up to `maxDelayMs`, default 3 minutes) and recovery returns only to the
 * interval. A bad row is dropped with a warning and the host falls back to the limiter default: a rate
 * nobody could read is never a licence to go faster.
 */
import type { HostRateConfig } from '../../driver/hostRateLimiter.js';

const DEFAULT_MAX_DELAY_MS = 180_000;
/** Below 100 ms is a burst, not a pace; above ten minutes is a typo. */
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 600_000;

const hostKey = (host: string): string => host.trim().toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');

/** `IMAGE_HOST_RATE_JSON` -> host -> limiter config; empty (and silent) when absent. */
export function parseImageHostRates(raw: string | undefined, warn: (message: string) => void = console.warn): Map<string, HostRateConfig> {
  const rates = new Map<string, HostRateConfig>();
  if (raw === undefined || raw.trim() === '') return rates;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`[IMAGE-RATE] IMAGE_HOST_RATE_JSON is not JSON (${err instanceof Error ? err.message : String(err)}) — every host keeps the default rate`);
    return rates;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn('[IMAGE-RATE] IMAGE_HOST_RATE_JSON must be an object of host -> { intervalMs } — every host keeps the default rate');
    return rates;
  }
  for (const [rawHost, row] of Object.entries(parsed as Record<string, unknown>)) {
    const host = hostKey(rawHost);
    const interval = row !== null && typeof row === 'object' ? (row as Record<string, unknown>).intervalMs : undefined;
    const ceiling = row !== null && typeof row === 'object' ? (row as Record<string, unknown>).maxDelayMs : undefined;
    if (host === '' || typeof interval !== 'number' || !Number.isInteger(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
      warn(`[IMAGE-RATE] IMAGE_HOST_RATE_JSON row '${rawHost.slice(0, 80)}' needs an integer intervalMs from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} — dropped`);
      continue;
    }
    if (ceiling !== undefined && (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling <= 0)) {
      warn(`[IMAGE-RATE] IMAGE_HOST_RATE_JSON row '${rawHost.slice(0, 80)}' has a maxDelayMs that is not a positive integer — dropped`);
      continue;
    }
    rates.set(host, {
      baseDelayMs: interval,
      minDelayMs: interval,
      maxDelayMs: Math.max(interval, (ceiling as number | undefined) ?? DEFAULT_MAX_DELAY_MS),
      backoffMultiplier: 1.4,
      recoveryDivisor: 1.4,
      successThreshold: 3,
    });
  }
  return rates;
}

/** The lookup `new HostRateLimiter(...)` takes: a configured host's rate, else undefined (the limiter default). */
export function imageHostRateFor(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): (host: string) => HostRateConfig | undefined {
  const rates = parseImageHostRates(env.IMAGE_HOST_RATE_JSON, warn);
  return host => rates.get(hostKey(host));
}
