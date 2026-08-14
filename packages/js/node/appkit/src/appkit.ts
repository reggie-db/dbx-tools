/**
 * AppKit runtime glue: the auto-configuring `createApp` drop-in, plus the
 * per-request execution context helpers and types derived from it.
 *
 * `createApp` runs dbx-tools auto-configuration, then delegates to AppKit's own
 * `createApp` with the same arguments and the same typed plugin-export map.
 * Drop it in as a one-for-one replacement:
 *
 * ```ts
 * import { lakebase, server } from "@databricks/appkit";
 * import { appkit } from "@dbx-tools/appkit";
 *
 * await appkit.createApp({ plugins: [server(), lakebase()] });
 * ```
 *
 * Auto-configuration runs BEFORE delegating so plugins see a fully populated
 * `process.env` during their synchronous `setup()`. Lakebase Postgres runs when
 * a `lakebase` plugin is present, or when {@link AutoConfigureMode} is set
 * explicitly on the config object.
 *
 * `getExecutionContext()` is AppKit's own accessor for the OBO-scoped workspace
 * client + request metadata; the wrappers here make it safe to call outside a
 * request scope ({@link tryGetExecutionContext}) and to lazily boot a bare app
 * ({@link ensureInitialized}), and re-export the derived types so add-on
 * packages can type a context / client without re-deriving them inline.
 *
 * @module
 */

import {
  createApp as appkitCreateApp,
  getExecutionContext,
  InitializationError,
} from "@databricks/appkit";
// AppKit's root barrel re-exports `PluginData` but not `PluginMap`; the package
// publishes this subpath for exactly that type.
import type { PluginMap } from "@databricks/appkit/dist/shared/src/plugin";
import { async, log } from "@dbx-tools/shared-core";

import { createSoftPersistentStorage } from "./_cache-storage.ts";
import { loadBrandContext } from "./brand.ts";
import {
  createInterceptorContext,
  type Interceptor,
  type InterceptorRuntime,
  lifecycleBridge,
  type ResolvedAppEnv,
} from "./interceptor.ts";
import { applyLakebaseEnv, type LakebaseConnection } from "./lakebase-resolver.ts";
import { provisionCacheSchema } from "./provision.ts";

const logger = log.logger("appkit");

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
  /**
   * One or many {@link Interceptor}s handed an {@link InterceptorContext} once
   * auto-configuration has computed the env. Each receives the resolved env, an
   * AppKit-lifecycle hook, and `bindProcess` for concurrently-style supervision -
   * see `./interceptor`. The tunnel is the primary consumer.
   */
  interceptor?: Interceptor | Interceptor[];
};

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

/** Plugin names for boot logs (order preserved). */
function pluginNames(config: CreateAppConfig | undefined): string[] {
  return (config?.plugins ?? []).map((entry) => entry.name);
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
 * import { appkit } from "@dbx-tools/appkit";
 *
 * // Populate PGHOST / PGDATABASE / LAKEBASE_ENDPOINT without booting AppKit.
 * await appkit.autoConfigure({ autoConfigure: "env" });
 */
export async function autoConfigure<T extends AppKitPlugins>(
  config?: CreateAppConfig<T>,
  signal?: AbortSignal,
): Promise<LakebaseConnection | undefined> {
  const mode = config?.autoConfigure ?? DEFAULT_AUTO_CONFIGURE;
  const explicit = config?.autoConfigure !== undefined;
  const lakebasePluginPresent = usesPlugin(config, LAKEBASE_PLUGIN);
  const plugins = pluginNames(config);
  logger.debug("autoConfigure: start", {
    mode,
    explicit,
    lakebasePluginPresent,
    plugins,
    timeoutMs: AUTO_CONFIGURE_TIMEOUT_MS,
    callerSignal: Boolean(signal),
  });

  if (mode === false || !(explicit || lakebasePluginPresent)) {
    const skippedReason = mode === false ? "disabled" : "no lakebase plugin";
    logger.debug("autoConfigure: skip", { skippedReason, mode, lakebasePluginPresent, plugins });
    logger.info("ready", {
      autoConfigure: mode,
      lakebasePluginPresent,
      provisioned: false,
      skippedReason,
    });
    return undefined;
  }

  const controller = new AbortController();
  async.tieAbortSignal(controller, signal);
  async.tieAbortSignal(controller, AbortSignal.timeout(AUTO_CONFIGURE_TIMEOUT_MS));

  const provision = mode === "provision";
  logger.debug("autoConfigure: resolve lakebase", { provision, mode });
  const resolved = await autoConfigureLakebase(provision, controller.signal);
  logger.debug("autoConfigure: done", {
    mode,
    lakebasePluginPresent,
    provisioned: provision,
    ...redactLakebaseConnection(resolved),
  });
  logger.info("ready", { autoConfigure: mode, lakebasePluginPresent, provisioned: provision });
  return resolved;
}

/**
 * Resolve Lakebase Postgres connection info, write the resolved values to
 * `process.env`, and return the record. Used by {@link autoConfigure}; call
 * {@link applyLakebaseEnv} directly when finer control is needed (a different
 * `autoCreate` policy, or a caller that wants the env without booting AppKit).
 */
async function autoConfigureLakebase(
  provision: boolean,
  signal: AbortSignal,
): Promise<LakebaseConnection> {
  logger.debug("autoConfigureLakebase: applyLakebaseEnv");
  const { resolved, user } = await applyLakebaseEnv(undefined, signal);
  logger.debug("autoConfigureLakebase: env applied", {
    ...redactLakebaseConnection(resolved),
    user,
    env: {
      LAKEBASE_ENDPOINT: process.env.LAKEBASE_ENDPOINT,
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGSSLMODE: process.env.PGSSLMODE,
    },
  });
  logger.info("env updated", { ...redactLakebaseConnection(resolved), user });
  if (provision) {
    logger.debug("autoConfigureLakebase: provisionCacheSchema", { user });
    await provisionCacheSchema(user, logger);
    logger.debug("autoConfigureLakebase: provisionCacheSchema done");
  } else {
    logger.debug("autoConfigureLakebase: skip provision (mode=env)");
  }
  return resolved;
}

/**
 * Whether `createApp` should inject soft-fail Lakebase cache storage.
 *
 * Skips when the caller disabled the cache, already supplied a storage
 * backend (including in-memory), or Lakebase is not in play.
 */
function shouldInjectSoftPersistentCache(
  config: CreateAppConfig | undefined,
  lakebase: LakebaseConnection | undefined,
): boolean {
  const cache = config?.cache;
  if (cache?.enabled === false) return false;
  if (cache?.storage) return false;
  return Boolean(lakebase) || usesPlugin(config, LAKEBASE_PLUGIN);
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

/** Build the {@link ResolvedAppEnv} interceptors read, from the auto-config result. */
function resolvedAppEnv(lakebase: LakebaseConnection | undefined): ResolvedAppEnv {
  return {
    ...(lakebase ? { lakebase } : {}),
    ...(process.env.DATABRICKS_HOST ? { databricksHost: process.env.DATABRICKS_HOST } : {}),
  };
}

/** Normalize the `interceptor?: Interceptor | Interceptor[]` option to an array. */
function interceptorList(interceptor: CreateAppConfig["interceptor"]): Interceptor[] {
  if (!interceptor) return [];
  return Array.isArray(interceptor) ? interceptor : [interceptor];
}

/**
 * Auto-configuring drop-in for AppKit's `createApp`: same config, same typed
 * plugin-export map, with {@link autoConfigure} run first.
 *
 * When {@link CreateAppConfig.interceptor}s are given, each is invoked with an
 * {@link InterceptorContext} AFTER auto-configuration computes the env and BEFORE
 * AppKit boots - so an interceptor can read the resolved connection, register
 * lifecycle handlers, and `bindProcess` a child. A hidden {@link lifecycleBridge}
 * plugin is injected so those `onLifecycle` handlers fire on the genuine AppKit
 * events; it has no exports, so the returned {@link PluginMap} is unchanged.
 *
 * @example
 * import { lakebase, server } from "@databricks/appkit";
 * import { appkit } from "@dbx-tools/appkit";
 *
 * const app = await appkit.createApp({ plugins: [server(), lakebase()] });
 */
export async function createApp<T extends AppKitPlugins>(
  config?: CreateAppConfig<T>,
): Promise<PluginMap<T>> {
  const plugins = pluginNames(config);
  const interceptors = interceptorList(config?.interceptor);
  logger.debug("createApp: start", {
    plugins,
    pluginCount: plugins.length,
    interceptorCount: interceptors.length,
    autoConfigure: config?.autoConfigure ?? "(default)",
    hasOnPluginsReady: typeof config?.onPluginsReady === "function",
  });

  logger.debug("createApp: autoConfigure");
  const brandContext = await loadBrandContext();
  logger.debug("createApp: brand context loaded", { name: brandContext.name });
  const lakebase = await autoConfigure(config);
  logger.debug("createApp: autoConfigure returned", {
    lakebase: lakebase ? redactLakebaseConnection(lakebase) : undefined,
  });

  const appConfig = { ...config };
  delete appConfig.autoConfigure;
  delete appConfig.interceptor;

  if (shouldInjectSoftPersistentCache(config, lakebase)) {
    logger.debug("createApp: inject soft persistent cache storage");
    const storage = await createSoftPersistentStorage(config?.cache);
    if (storage) {
      appConfig.cache = { ...config?.cache, storage };
      logger.debug("createApp: soft persistent cache storage ready");
    } else {
      logger.debug("createApp: soft persistent cache storage unavailable");
    }
  }

  if (interceptors.length === 0) {
    logger.debug("createApp: no interceptors; delegating to AppKit createApp", {
      plugins: pluginNames(appConfig),
    });
    const result = await appkitCreateApp<T>(appConfig);
    logger.debug("createApp: AppKit createApp returned", {
      exportKeys: Object.keys(result ?? {}),
    });
    return result;
  }

  // Build the context from the computed env, run each interceptor (they register
  // lifecycle handlers + bind processes), then inject the bridge that relays the
  // REAL AppKit lifecycle into `runtime.emitLifecycle` during its `setup()`.
  const env = resolvedAppEnv(lakebase);
  logger.debug("createApp: interceptor context", {
    hasLakebase: Boolean(env.lakebase),
    databricksHost: env.databricksHost,
    interceptorCount: interceptors.length,
  });
  const runtime: InterceptorRuntime = createInterceptorContext(env);
  for (let i = 0; i < interceptors.length; i++) {
    logger.debug("createApp: run interceptor", { index: i, of: interceptors.length });
    await interceptors[i]!(runtime.context);
    logger.debug("createApp: interceptor done", { index: i });
  }
  // Append the bridge to the plugins tuple. It is hidden and exports nothing, so
  // the returned map still matches `PluginMap<T>`; the cast (through `unknown`) is
  // only because appending widens the tuple type beyond `T`.
  appConfig.plugins = [...(appConfig.plugins ?? []), lifecycleBridge({ runtime })] as unknown as T;
  logger.debug("createApp: lifecycle bridge injected; delegating to AppKit createApp", {
    plugins: pluginNames(appConfig),
  });
  const result = await appkitCreateApp<T>(appConfig);
  logger.debug("createApp: AppKit createApp returned", {
    exportKeys: Object.keys(result ?? {}),
  });
  return result;
}

/**
 * The AppKit per-request execution context returned by `getExecutionContext()`
 * - the OBO-scoped workspace client plus the surrounding request metadata.
 * Derived from AppKit's own return type so it tracks the installed version, and
 * re-exported here so add-on packages can type a context parameter without each
 * re-deriving the same `ReturnType<typeof getExecutionContext>` inline.
 */
export type ExecutionContextLike = ReturnType<typeof getExecutionContext>;

/**
 * The auth-scoped Databricks workspace client carried on an
 * `ExecutionContextLike` (`getExecutionContext().client`). Typed structurally
 * off AppKit so consumers don't take a direct `@databricks/sdk-experimental`
 * dependency - the dep flows in transitively through `@databricks/appkit`.
 */
export type WorkspaceClientLike = ExecutionContextLike["client"];

/**
 * The current AppKit execution context, or `undefined` when AppKit isn't
 * initialized (outside a request scope). Swallows AppKit's
 * {@link InitializationError}; any other error propagates.
 *
 * @example
 * import { appkit } from "@dbx-tools/appkit";
 * import { createWorkspaceClient } from "@databricks/appkit";
 *
 * // OBO-scoped inside a request, service principal from a CLI or script.
 * const client = appkit.tryGetExecutionContext()?.client ?? createWorkspaceClient();
 */
export function tryGetExecutionContext(): ExecutionContextLike | undefined {
  try {
    const ctx = getExecutionContext();
    if (ctx?.client) {
      return ctx;
    }
  } catch (error) {
    if (!(error instanceof InitializationError)) {
      throw error;
    }
  }
  return undefined;
}

/**
 * Initialize a bare AppKit app (no plugins) when none is running yet.
 *
 * @example
 * import { appkit } from "@dbx-tools/appkit";
 *
 * await appkit.ensureInitialized();
 * const client = appkit.tryGetExecutionContext()?.client;
 */
export async function ensureInitialized(): Promise<void> {
  if (tryGetExecutionContext()) {
    logger.debug("ensureInitialized: already initialized");
    return;
  }
  logger.debug("ensureInitialized: booting bare AppKit app");
  await createApp({ plugins: [], autoConfigure: false });
  logger.debug("ensureInitialized: done");
}
