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
 *
 * A plugin is loaded whole or not at all. register() receives the four
 * methods of a staged PluginRegistration, not the shared registry: its calls
 * are committed only after register() and registerRoutes() have both
 * succeeded, and only then are its routes mounted. So a plugin that fails
 * anywhere — including a hands-off policy the registry refused, even one the
 * plugin caught — leaves none of its sites, rulesets, policies, classifier or
 * routes behind: its stores never go live without a policy it registered
 * while loading. Once the plugin has loaded its registration is closed, so a
 * late call throws and takes no effect rather than arriving after its stores
 * went live.
 *
 * The result names the refused plugins beside the loaded ones: /health/detailed
 * lists both (pluginsView), and src/index.ts restores the durable scrape queue
 * only when the registry came up whole (durableQueueHold).
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
  /** The plugins that loaded, in discovery order. */
  plugins: ScraperPlugin[];
  /** The plugins that failed to load (none of their registrations were kept), in discovery order. */
  refused: ScraperPlugin[];
}

/** One plugin as /health/detailed lists it. */
export interface PluginRef {
  name: string;
  version: string;
}

/**
 * The `plugins` block on /health/detailed: which plugins loaded and which were refused at startup.
 * Names and versions only; why a plugin was refused is in the pod log, not on that endpoint.
 */
export interface PluginsView {
  loaded: PluginRef[];
  refused: PluginRef[];
}

export async function bootstrapPlugins(app: Express, options: BootstrapPluginsOptions = {}): Promise<BootstrapPluginsResult> {
  const registry = createExtractionRegistry();
  const config = createRuntimeConfig();
  const services = buildEngineServices();

  const nodeModulesDir = options.nodeModulesDir ?? (process.env.PLUGIN_DIR || undefined);
  const discover = options.discover ?? (() => discoverPlugins({ nodeModulesDir }));
  const candidates = await discover();

  const loaded: ScraperPlugin[] = [];
  const refused: ScraperPlugin[] = [];

  for (const plugin of candidates) {
    const logger = createPluginLogger(`plugin:${plugin.name}`);
    const context: PluginContext = { logger, config, services };

    const registration = registry.beginRegistration();

    try {
      await plugin.register(registration.forPlugin(), context);

      let router: Router | undefined;
      if (plugin.registerRoutes) {
        router = Router();
        plugin.registerRoutes(router as unknown as ExpressRouter);
      }

      // The last step that can fail: after it, nothing below throws.
      registration.commit();
      if (router) app.use('/', router);

      loaded.push(plugin);
      console.log(`[PLUGIN BOOTSTRAP] Registered plugin ${plugin.name}@${plugin.version}`);
    } catch (error) {
      registration.discard();
      refused.push(plugin);
      console.error(
        `[PLUGIN BOOTSTRAP] Failed to register plugin "${plugin.name}"; none of its sites, rulesets, policies or routes were kept:`,
        error
      );
    }
  }

  return { registry, plugins: loaded, refused };
}

/**
 * Why the durable scrape queue must be HELD rather than restored after this bootstrap, or undefined
 * when it may be restored. A restored row whose store has no ruleset fails EXTRACTION_UNAVAILABLE,
 * which is terminal, and is deleted from disk; so the queue is restored only into a registry that
 * came up whole: no plugin refused, and at least one store registered.
 */
export function durableQueueHold({ registry, refused }: BootstrapPluginsResult): string | undefined {
  if (refused.length > 0) return `plugin(s) refused at startup: ${refused.map(plugin => plugin.name).join(', ')}`;
  if (registry.allStores().length === 0) return 'no plugin registered a store';
  return undefined;
}

/** The `plugins` block on /health/detailed for a bootstrap result; both lists empty before it has run. */
export function pluginsView(result: Pick<BootstrapPluginsResult, 'plugins' | 'refused'> | undefined): PluginsView {
  const ref = ({ name, version }: ScraperPlugin): PluginRef => ({ name, version });
  return { loaded: (result?.plugins ?? []).map(ref), refused: (result?.refused ?? []).map(ref) };
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
