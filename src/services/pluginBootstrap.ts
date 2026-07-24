/**
 * Plugin Bootstrap
 *
 * Wires the generic plugin-loading seam together: discover candidate
 * plugins, build the shared ExtractionRegistry + PluginContext, await
 * register() per plugin, mount registerRoutes() onto the running Express
 * app, and hand back the loaded plugin list so the caller (src/index.ts)
 * can wire shutdown() into SIGTERM/SIGINT.
 *
 * A single misbehaving plugin (throws in register(), or fails the
 * ScraperPlugin shape check upstream in pluginLoader) is logged and skipped
 * rather than taking down the whole engine boot.
 */
import { Router, type Express } from 'express';
import { discoverPlugins } from './pluginLoader.js';
import { createExtractionRegistry, ExtractionRegistryImpl } from './extractionRegistry.js';
import { buildEngineServices, createRuntimeConfig, createPluginLogger } from './engineServices/index.js';
import { ScraperPlugin, PluginContext, ExpressRouter } from '@figurecollecting/scraper-plugin-contract';

export interface BootstrapPluginsOptions {
  /**
   * Directory to scan for candidate plugin packages (forwarded to
   * discoverPlugins). Falls back to the PLUGIN_DIR environment variable when
   * not provided, then to the process's own node_modules — so runtime-injected
   * plugins (e.g. a mounted volume in a container) can live outside
   * process.cwd()/node_modules.
   */
  nodeModulesDir?: string;
  /** Full override of plugin discovery — primarily for tests. */
  discover?: () => Promise<ScraperPlugin[]>;
}

export interface BootstrapPluginsResult {
  registry: ExtractionRegistryImpl;
  plugins: ScraperPlugin[];
}

export async function bootstrapPlugins(app: Express, options: BootstrapPluginsOptions = {}): Promise<BootstrapPluginsResult> {
  const registry = createExtractionRegistry();
  const config = createRuntimeConfig();
  const services = buildEngineServices();

  const nodeModulesDir = options.nodeModulesDir ?? (process.env.PLUGIN_DIR || undefined);
  const discover = options.discover ?? (() => discoverPlugins({ nodeModulesDir }));
  const candidates = await discover();

  const loaded: ScraperPlugin[] = [];

  for (const plugin of candidates) {
    const logger = createPluginLogger(`plugin:${plugin.name}`);
    const context: PluginContext = { logger, config, services };

    try {
      await plugin.register(registry, context);

      if (plugin.registerRoutes) {
        const router = Router();
        plugin.registerRoutes(router as unknown as ExpressRouter);
        app.use('/', router);
      }

      loaded.push(plugin);
      console.log(`[PLUGIN BOOTSTRAP] Registered plugin ${plugin.name}@${plugin.version}`);
    } catch (error) {
      console.error(`[PLUGIN BOOTSTRAP] Failed to register plugin "${plugin.name}":`, error);
    }
  }

  return { registry, plugins: loaded };
}

/**
 * Call shutdown() on every loaded plugin. Failures are logged, not thrown —
 * one plugin's broken shutdown hook shouldn't block the rest of graceful
 * shutdown (browser pool close, process exit).
 */
export async function shutdownPlugins(plugins: ScraperPlugin[]): Promise<void> {
  await Promise.all(
    plugins.map(async plugin => {
      if (!plugin.shutdown) return;
      try {
        await plugin.shutdown();
      } catch (error) {
        console.error(`[PLUGIN BOOTSTRAP] Error shutting down plugin "${plugin.name}":`, error);
      }
    })
  );
}
