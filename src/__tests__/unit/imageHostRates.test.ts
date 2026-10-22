/**
 * The per-image-host RATE seam (MFC-GALLERY-2): IMAGE_HOST_RATE_JSON turns "how fast may we hit this CDN" into one
 * number of config. A row pins the host's gap — base AND floor — so a run of successes never speeds it up the way the
 * limiter's default (2,067 ms easing toward 274 ms) does; a 429/503 still backs it off.
 */
import { HostRateLimiter } from '../../driver/hostRateLimiter';
import { imageHostRateFor, parseImageHostRates } from '../../services/images/imageHostRates';

const HOST = 'static.myfigurecollection.net';
const quiet = () => undefined;

describe('parseImageHostRates', () => {
  it('reads a row into a limiter config whose base and floor are the interval', () => {
    const rates = parseImageHostRates(JSON.stringify({ [HOST]: { intervalMs: 1000 } }), quiet);
    expect(rates.get(HOST)).toEqual({
      baseDelayMs: 1000, minDelayMs: 1000, maxDelayMs: 180_000, backoffMultiplier: 1.4, recoveryDivisor: 1.4, successThreshold: 3,
    });
  });

  it('takes an explicit ceiling for the back-off, never below the interval', () => {
    const rates = parseImageHostRates(JSON.stringify({ a: { intervalMs: 2000, maxDelayMs: 60_000 }, b: { intervalMs: 5000, maxDelayMs: 100 } }), quiet);
    expect(rates.get('a')!.maxDelayMs).toBe(60_000);
    expect(rates.get('b')!.maxDelayMs).toBe(5000);
  });

  it('normalises the host key like the limiter does: lower case, trimmed, www. stripped, trailing dot dropped', () => {
    const rates = parseImageHostRates(JSON.stringify({ ' WWW.Cdn.Example.COM. ': { intervalMs: 500 } }), quiet);
    expect([...rates.keys()]).toEqual(['cdn.example.com']);
  });

  it('is empty and silent for an absent or blank value', () => {
    const warn = jest.fn();
    expect(parseImageHostRates(undefined, warn).size).toBe(0);
    expect(parseImageHostRates('  ', warn).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    ['a string', '"x"'],
  ])('warns and returns nothing for %s', (_label, raw) => {
    const warn = jest.fn();
    expect(parseImageHostRates(raw, warn).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('IMAGE_HOST_RATE_JSON');
  });

  it('drops a bad row with a warning and keeps the good ones', () => {
    const warn = jest.fn();
    const rates = parseImageHostRates(JSON.stringify({
      good: { intervalMs: 1000 },
      zero: { intervalMs: 0 },
      tiny: { intervalMs: 50 },
      huge: { intervalMs: 9_999_999 },
      text: { intervalMs: '1000' },
      noRow: 7,
      missing: {},
      badMax: { intervalMs: 1000, maxDelayMs: 'x' },
    }), warn);
    expect([...rates.keys()]).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(7);
  });
});

describe('imageHostRateFor', () => {
  it('answers per host from the env and leaves every other host to the limiter default', () => {
    const rateFor = imageHostRateFor({ IMAGE_HOST_RATE_JSON: JSON.stringify({ [HOST]: { intervalMs: 1000 } }) }, quiet);
    expect(rateFor(HOST)?.baseDelayMs).toBe(1000);
    expect(rateFor('www.' + HOST)?.baseDelayMs).toBe(1000);
    expect(rateFor('cdn.shopify.com')).toBeUndefined();
  });

  it('spaces dispatches by exactly the interval and does not speed up on success', () => {
    const limiter = new HostRateLimiter(imageHostRateFor({ IMAGE_HOST_RATE_JSON: JSON.stringify({ [HOST]: { intervalMs: 1000 } }) }, quiet));
    limiter.recordDispatch(HOST, 0);
    expect(limiter.msUntilReady(HOST, 0)).toBe(1000);
    expect(limiter.msUntilReady(HOST, 400)).toBe(600);
    for (let i = 0; i < 30; i++) limiter.recordSuccess(HOST);
    expect(limiter.currentDelay(HOST)).toBe(1000);
  });

  it('still backs off after a 429/503 and recovers only back to the interval', () => {
    const limiter = new HostRateLimiter(imageHostRateFor({ IMAGE_HOST_RATE_JSON: JSON.stringify({ [HOST]: { intervalMs: 1000 } }) }, quiet));
    limiter.recordRateLimited(HOST);
    expect(limiter.currentDelay(HOST)).toBeCloseTo(1400, 5);
    for (let i = 0; i < 60; i++) limiter.recordSuccess(HOST);
    expect(limiter.currentDelay(HOST)).toBe(1000);
  });

  it('with no env, is a lookup that knows no host', () => {
    expect(imageHostRateFor({}, quiet)(HOST)).toBeUndefined();
  });
});
