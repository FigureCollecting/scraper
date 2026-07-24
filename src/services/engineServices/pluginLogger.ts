/**
 * PluginLogger adapter — wraps the engine's existing debug logger with a
 * fixed namespace per plugin, so every log line a plugin emits is
 * attributable (e.g. "[plugin:mock-scraper-ruleset] ...").
 */
import { logger } from '../../utils/logger.js';
import { PluginLogger } from '@figurecollecting/scraper-plugin-contract';

export function createPluginLogger(namespace: string): PluginLogger {
  return {
    info(message: string, meta?: Record<string, unknown>): void {
      logger.info(`[${namespace}] ${message}`, meta);
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      logger.warn(`[${namespace}] ${message}`, meta);
    },
    error(message: string, meta?: Record<string, unknown>): void {
      logger.error(`[${namespace}] ${message}`, meta);
    },
    debug(message: string, meta?: Record<string, unknown>): void {
      logger.debug(namespace, message, meta);
    },
  };
}
