/**
 * The services handed to plugins (PluginContext.services) carry the scraping service built with
 * caller 'pluginRoute', so the rulesets' plugin-mounted routes pass the host clock (QB-U30b).
 */
const mockCreateScrapingService = jest.fn(() => ({}));
jest.mock('../../../services/engineServices/scrapingService', () => ({
  createScrapingService: (...args: unknown[]) => mockCreateScrapingService(...(args as [])),
}));

import { buildEngineServices } from '../../../services/engineServices';

it("buildEngineServices builds the plugins' scraping service with caller 'pluginRoute'", () => {
  buildEngineServices();
  expect(mockCreateScrapingService).toHaveBeenCalledWith(expect.anything(), { clockCaller: 'pluginRoute' });
});
