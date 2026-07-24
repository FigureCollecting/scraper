/**
 * Barrel: assembles the concrete EngineServices bundle handed to plugins via
 * PluginContext.services.
 */
import { EngineServices } from '@figurecollecting/scraper-plugin-contract';
import { createScrapingService } from './scrapingService.js';
import { createQueueService } from './queueService.js';
import { createSessionService } from './sessionService.js';
import { createWebhookService } from './webhookService.js';

export { createRuntimeConfig, EnvRuntimeConfig } from './runtimeConfig.js';
export { createPluginLogger } from './pluginLogger.js';
export { createScrapingService } from './scrapingService.js';
export { createQueueService } from './queueService.js';
export { createSessionService } from './sessionService.js';
export { createWebhookService } from './webhookService.js';

export function buildEngineServices(): EngineServices {
  return {
    scraping: createScrapingService(),
    queue: createQueueService(),
    sessions: createSessionService(),
    webhooks: createWebhookService(),
  };
}
