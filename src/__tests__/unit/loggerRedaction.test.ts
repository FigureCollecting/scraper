import { logger } from '../../utils/logger';

/**
 * Proves fc-shared's redactValue is layered on top of the logger's existing
 * field-name sanitizeData, so both secret-SHAPE values (a bare 'Bearer ...'
 * string) and sensitive fields ({ token }) are scrubbed from the serialized log
 * payload before it reaches the console. Belt-and-suspenders with the legacy
 * field redaction — neither shape should ever leak.
 */
describe('logger payload redaction', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('redacts a token field AND a Bearer secret hidden under an innocent field name', () => {
    logger.info('auth attempt', {
      token: 'x',
      // 'header' is NOT in sanitizeData's field-name list — only redactValue's
      // secret-SHAPE matching catches the Bearer value here. This isolates the
      // new redaction layer from the legacy field-name sanitizer.
      header: 'Bearer abcdefghij',
      keepMe: 'visible',
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const serialized = logSpy.mock.calls[0][1] as string;

    expect(serialized).not.toContain('Bearer abcdefghij');
    expect(serialized).not.toContain('"token": "x"');
    expect(serialized).toContain('[REDACTED]');
    // Non-sensitive fields survive.
    expect(serialized).toContain('visible');
  });

  it('redacts a Bearer secret string passed as the whole error payload', () => {
    logger.error('auth failure', { header: 'Bearer abcdefghij', token: 'x' });

    expect(errSpy).toHaveBeenCalledTimes(1);
    const serialized = errSpy.mock.calls[0][1] as string;

    expect(serialized).not.toContain('Bearer abcdefghij');
    expect(serialized).not.toContain('"token": "x"');
    expect(serialized).toContain('[REDACTED]');
  });
});
