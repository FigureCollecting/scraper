import { selectEgressTimezone } from '../../services/browserTimezone';

/**
 * Cloudflare scores the browser's timezone against the exit IP's geolocation. Measured 2026-09-07:
 * the residential exit (Florida) with the browser on UTC stays on "Just a moment" forever, and the
 * SAME setup with America/Chicago passes. So the timezone follows the EGRESS, not the process.
 */
describe('selectEgressTimezone', () => {
  it('uses RESIDENTIAL_EGRESS_TIMEZONE for a residential-egress context', () => {
    const env = { RESIDENTIAL_EGRESS_TIMEZONE: 'America/Chicago', DIRECT_EGRESS_TIMEZONE: 'America/New_York' } as NodeJS.ProcessEnv;

    expect(selectEgressTimezone(true, env)).toBe('America/Chicago');
  });

  it('uses DIRECT_EGRESS_TIMEZONE for a direct context', () => {
    const env = { RESIDENTIAL_EGRESS_TIMEZONE: 'America/Chicago', DIRECT_EGRESS_TIMEZONE: 'America/New_York' } as NodeJS.ProcessEnv;

    expect(selectEgressTimezone(false, env)).toBe('America/New_York');
  });

  it('is undefined when the chosen variable is unset — never emulate a timezone nobody configured', () => {
    expect(selectEgressTimezone(true, { DIRECT_EGRESS_TIMEZONE: 'America/New_York' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(selectEgressTimezone(false, { RESIDENTIAL_EGRESS_TIMEZONE: 'America/Chicago' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(selectEgressTimezone(true, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('treats a blank/whitespace value as unset, and trims a padded one', () => {
    expect(selectEgressTimezone(true, { RESIDENTIAL_EGRESS_TIMEZONE: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(selectEgressTimezone(false, { DIRECT_EGRESS_TIMEZONE: '' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(selectEgressTimezone(true, { RESIDENTIAL_EGRESS_TIMEZONE: ' America/Chicago ' } as NodeJS.ProcessEnv)).toBe('America/Chicago');
  });

  it('does not cross the wires: neither variable can serve the other egress', () => {
    const env = { RESIDENTIAL_EGRESS_TIMEZONE: 'America/Chicago' } as NodeJS.ProcessEnv;

    expect(selectEgressTimezone(false, env)).toBeUndefined();
  });
});
