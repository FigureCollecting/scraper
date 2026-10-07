/**
 * Plugin Bootstrap
 *
 * Wires the generic plugin-loading seam together: discover candidate
 * plugins, build the shared ExtractionRegistry + PluginContext, await
 * register() per plugin, mount registerRoutes() onto the running Express
 * app, and hand back the loaded plugin list so the caller (src/index.ts)
 * can wire shutdown() into SIGTERM/SIGINT.
 *
 * A single misbehaving plugin (fails to import or fails the ScraperPlugin
 * shape check upstream in pluginLoader, or throws in register()) is logged,
 * skipped and listed as refused rather than taking down the whole engine boot.
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
 * only when the registry came up whole (settleDurableQueue, durableQueueHold).
 */
import { Router, type Express } from 'express';
import { discoverPluginCandidates, type PluginDiscovery } from './pluginLoader.js';
import type { ScrapeQueue } from './scrapeQueue.js';
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
  /** Full override of plugin discovery — primarily for tests. It reports no candidate that failed to load. */
  discover?: () => Promise<ScraperPlugin[]>;
}

/** One plugin as /health/detailed lists it. */
export interface PluginRef {
  name: string;
  version: string;
}

export interface BootstrapPluginsResult {
  registry: ExtractionRegistryImpl;
  /** The plugins that loaded, in discovery order. */
  plugins: ScraperPlugin[];
  /**
   * The plugins that did not load, none of their registrations kept: first the candidate packages
   * that failed to import or failed the ScraperPlugin shape check (named from their package.json),
   * then the plugins refused while they registered, each in discovery order.
   */
  refused: PluginRef[];
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
  const discovery: PluginDiscovery = options.discover
    ? { plugins: await options.discover(), failed: [] }
    : await discoverPluginCandidates({ nodeModulesDir });

  const loaded: ScraperPlugin[] = [];
  const refused: PluginRef[] = discovery.failed.map(({ name, version }) => ({ name, version }));

  for (const plugin of discovery.plugins) {
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
      refused.push({ name: plugin.name, version: plugin.version });
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

/** The two ScrapeQueue methods the startup decision drives. */
export type SettleableQueue = Pick<ScrapeQueue, 'restoreFromStore' | 'holdQueueStore'>;

/**
 * The startup decision for the durable scrape queue, made ONCE, after the plugins have loaded: restore
 * it into a registry that came up whole, otherwise HOLD it (durableQueueHold says why). `undefined`
 * means the bootstrap did not complete (it threw, or its registry never reached the queue), which holds
 * too. A restore that throws (a row the store cannot read back, an I/O error mid-read) holds the queue
 * as well, so it never ends the process: the row would still be there at every start. Returns why the
 * queue was held, or undefined when it was restored.
 */
export function settleDurableQueue(queue: SettleableQueue, bootstrap: BootstrapPluginsResult | undefined): string | undefined {
  const hold = bootstrap === undefined ? 'the plugin bootstrap did not complete' : durableQueueHold(bootstrap);
  if (hold !== undefined) {
    queue.holdQueueStore(hold);
    return hold;
  }
  try {
    queue.restoreFromStore();
    return undefined;
  } catch (error) {
    console.error('[PLUGIN BOOTSTRAP] Restoring the durable scrape queue failed; holding it instead:', error);
    const why = `the durable queue could not be restored (${error instanceof Error ? error.message : String(error)})`;
    queue.holdQueueStore(why);
    return why;
  }
}

/** The `plugins` block on /health/detailed for a bootstrap result; both lists empty before it has run. */
export function pluginsView(result: Pick<BootstrapPluginsResult, 'plugins' | 'refused'> | undefined): PluginsView {
  const ref = ({ name, version }: PluginRef): PluginRef => ({ name, version });
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
