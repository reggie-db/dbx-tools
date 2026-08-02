/**
 * `createApp` wrapper: runs dbx-tools auto-configuration, then delegates to
 * AppKit's own `createApp` with the exact same arguments.
 *
 * Drop it in as a one-for-one replacement for `@databricks/appkit`'s
 * `createApp` - same parameters, same return type, full plugin-export inference
 * preserved:
 *
 * ```ts
 * import { createApp } from "@dbx-tools/appkit";
 * import { lakebase, server } from "@databricks/appkit";
 *
 * await createApp.createApp({ plugins: [server(), lakebase()] });
 * ```
 *
 * Auto-configuration runs BEFORE delegating so plugins see a fully populated
 * `process.env` during their synchronous `setup()`. Lakebase Postgres runs when
 * a `lakebase` plugin is present, or when {@link AutoConfigureMode} is set
 * explicitly on the config object.
 *
 * @module
 */

import { createApp as appkitCreateApp, getUsernameWithApiLookup } from "@databricks/appkit";
// AppKit's root barrel re-exports `PluginData` but not `PluginMap`; the package
// publishes this subpath for exactly that type.
import type { PluginMap } from "@databricks/appkit/dist/shared/src/plugin";
import { async, log } from "@dbx-tools/shared-core";

import {
  applyLakebaseToEnv,
  resolveLakebaseConnection,
  type LakebaseConnection,
} from "./lakebase-resolver.ts";
import { provisionCacheSchema } from "./provision.ts";

type AppKitCreateAppConfig = NonNullable<Parameters<typeof appkitCreateApp>[0]>;
type AppKitPlugins = NonNullable<AppKitCreateAppConfig["plugins"]>;

/**
 * What auto-configuration does before AppKit boots.
 *
 * - `"provision"`: resolve the Lakebase connection into `process.env`, then
 *   grant the AppKit cache schema to the connecting role.
 * - `"env"`: resolve the Lakebase connection into `process.env` only.
 *
 * Omit it to get `"provision"` gated on a `lakebase` plugin being registered;
 * set it explicitly to run regardless of the plugin list, or pass `false` to
 * skip auto-configuration entirely.
 *
 * Set it EXPLICITLY on an app that has no `lakebase()` plugin but still wants
 * AppKit's PERSISTENT cache. AppKit picks Lakebase for `CacheManager` only when
 * `createLakebasePool()` can build a pool, and that reads `LAKEBASE_ENDPOINT` /
 * `PGHOST` / `PGDATABASE` straight from `process.env` - so without this step the
 * cache silently falls back to in-memory, and anything it holds (a session
 * signing key, a one-time code) is lost on restart. `"env"` is the right mode
 * there: the app SP cannot grant on the cache schema anyway.
 */
export type AutoConfigureMode = "env" | "provision";

/** AppKit's `createApp` config plus the dbx-tools auto-configuration switch. */
export type CreateAppConfig<T extends AppKitPlugins = AppKitPlugins> = Omit<
  AppKitCreateAppConfig,
  "plugins" | "onPluginsReady"
> & {
  plugins?: T;
  onPluginsReady?: (appkit: PluginMap<T>) => void | Promise<void>;
  /** Auto-configuration to run before AppKit boots. Defaults to `"provision"`. */
  autoConfigure?: AutoConfigureMode | false;
};

const logger = log.logger("create-app");

const LAKEBASE_PLUGIN = "lakebase";
const DEFAULT_AUTO_CONFIGURE: AutoConfigureMode = "provision";

/**
 * Upper bound on boot-time auto-configuration. It runs as the service principal
 * before any plugin is constructed, so it sits outside AppKit's interceptor
 * chain and inherits no timeout, retry, or telemetry from it. The budget covers
 * the resolver's own worst case (create a project, then wait for its endpoint)
 * plus the cache-schema grants.
 */
const AUTO_CONFIGURE_TIMEOUT_MS = 11 * 60_000;

function usesPlugin<T extends AppKitPlugins>(
  config: CreateAppConfig<T> | undefined,
  name: string,
): boolean {
  return Boolean(config?.plugins?.some((entry) => entry.name === name));
}

/**
 * Run enabled auto-configuration steps without calling AppKit's `createApp`.
 *
 * Lakebase Postgres resolves when {@link CreateAppConfig.autoConfigure} is set
 * explicitly or a `lakebase` plugin is listed in `config.plugins`. `signal`
 * cancels the resolution; it is combined with an internal boot timeout either
 * way.
 *
 * @example
 * import { createApp } from "@dbx-tools/appkit";
 *
 * // Populate PGHOST / PGDATABASE / LAKEBASE_ENDPOINT without booting AppKit.
 * await createApp.autoConfigure({ autoConfigure: "env" });
 */
export async function autoConfigure<T extends AppKitPlugins>(
  config?: CreateAppConfig<T>,
  signal?: AbortSignal,
): Promise<void> {
  const mode = config?.autoConfigure ?? DEFAULT_AUTO_CONFIGURE;
  const explicit = config?.autoConfigure !== undefined;
  const lakebasePluginPresent = usesPlugin(config, LAKEBASE_PLUGIN);
  if (mode === false || !(explicit || lakebasePluginPresent)) {
    logger.info("ready", {
      autoConfigure: mode,
      lakebasePluginPresent,
      provisioned: false,
      skippedReason: mode === false ? "disabled" : "no lakebase plugin",
    });
    return;
  }

  const controller = new AbortController();
  async.tieAbortSignal(controller, signal);
  async.tieAbortSignal(controller, AbortSignal.timeout(AUTO_CONFIGURE_TIMEOUT_MS));

  const provision = mode === "provision";
  await autoConfigureLakebase(provision, controller.signal);
  logger.info("ready", { autoConfigure: mode, lakebasePluginPresent, provisioned: provision });
}

/**
 * Resolve Lakebase Postgres connection info, write the resolved values to
 * `process.env`, and return the record. Used by {@link autoConfigure}; call
 * {@link resolveLakebaseConnection} and {@link applyLakebaseToEnv} directly when
 * finer control is needed.
 */
async function autoConfigureLakebase(
  provision: boolean,
  signal: AbortSignal,
): Promise<LakebaseConnection> {
  const resolved = await resolveLakebaseConnection(undefined, signal);
  applyLakebaseToEnv(resolved);
  const user = await getUsernameWithApiLookup({});
  if (user) process.env.PGUSER ??= user;
  logger.info("env updated", { ...redactLakebaseConnection(resolved), user });
  if (provision) {
    await provisionCacheSchema(user, logger);
  }
  return resolved;
}

function redactLakebaseConnection(resolved: LakebaseConnection): Record<string, unknown> {
  return {
    project: resolved.project,
    branch: resolved.branch,
    endpoint: resolved.endpoint,
    database: resolved.database,
    host: resolved.host,
    port: resolved.port,
    sslMode: resolved.sslMode,
  };
}

/**
 * Auto-configuring drop-in for AppKit's `createApp`: same config, same typed
 * plugin-export map, with {@link autoConfigure} run first.
 *
 * @example
 * import { createApp } from "@dbx-tools/appkit";
 * import { lakebase, server } from "@databricks/appkit";
 *
 * const app = await createApp.createApp({ plugins: [server(), lakebase()] });
 */
export async function createApp<T extends AppKitPlugins>(
  config?: CreateAppConfig<T>,
): Promise<PluginMap<T>> {
  await autoConfigure(config);
  const appConfig = { ...config };
  delete appConfig.autoConfigure;
  return appkitCreateApp<T>(appConfig);
}
