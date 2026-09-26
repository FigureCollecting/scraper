/**
 * A rotating list id or group name: it becomes a key in the crawler's lists state and a url parameter.
 * A leaf module so the crawler, which imports nothing from the driver, applies the catalog's exact rule.
 */
export const isSafeRotatingName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._-]+$/.test(v) && v !== '__proto__';
