import { jest } from '@jest/globals';

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { logger } from '../../../utils/logger';
import { createPluginLogger } from '../../../services/engineServices/pluginLogger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('createPluginLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefixes info messages with the plugin namespace', () => {
    const pluginLogger = createPluginLogger('plugin:mock-scraper-ruleset');
    pluginLogger.info('registered', { siteCount: 1 });

    expect(mockedLogger.info).toHaveBeenCalledWith('[plugin:mock-scraper-ruleset] registered', { siteCount: 1 });
  });

  it('prefixes warn messages with the plugin namespace', () => {
    const pluginLogger = createPluginLogger('plugin:mock-scraper-ruleset');
    pluginLogger.warn('slow response');

    expect(mockedLogger.warn).toHaveBeenCalledWith('[plugin:mock-scraper-ruleset] slow response', undefined);
  });

  it('prefixes error messages with the plugin namespace', () => {
    const pluginLogger = createPluginLogger('plugin:mock-scraper-ruleset');
    pluginLogger.error('failed', { code: 'E_TIMEOUT' });

    expect(mockedLogger.error).toHaveBeenCalledWith('[plugin:mock-scraper-ruleset] failed', { code: 'E_TIMEOUT' });
  });

  it('routes debug messages through the namespaced debug channel', () => {
    const pluginLogger = createPluginLogger('plugin:mock-scraper-ruleset');
    pluginLogger.debug('verbose detail', { step: 1 });

    expect(mockedLogger.debug).toHaveBeenCalledWith('plugin:mock-scraper-ruleset', 'verbose detail', { step: 1 });
  });
});
