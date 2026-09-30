import type { AutoConfigureMode } from "./appkit.ts";

const LAKEBASE_PLUGIN = "lakebase";
const DATABASE_PLUGIN = "database";

/** Resolved automatic database-environment and cache-provisioning decision. */
export interface AutoConfigurePolicy {
  mode: AutoConfigureMode | false;
  explicit: boolean;
  lakebasePluginPresent: boolean;
  databasePluginPresent: boolean;
  shouldResolve: boolean;
  provision: boolean;
  skippedReason?: "disabled" | "no database plugin";
}

/** Resolve database demand without constructing another native plugin or pool. */
export function resolveAutoConfigurePolicy(
  plugins: readonly string[],
  configured: AutoConfigureMode | false | undefined,
): AutoConfigurePolicy {
  const mode = configured ?? "provision";
  const explicit = configured !== undefined;
  const lakebasePluginPresent = plugins.includes(LAKEBASE_PLUGIN);
  const databasePluginPresent = plugins.includes(DATABASE_PLUGIN);
  const shouldResolve =
    mode !== false && (explicit || lakebasePluginPresent || databasePluginPresent);
  return {
    mode,
    explicit,
    lakebasePluginPresent,
    databasePluginPresent,
    shouldResolve,
    provision: mode === "provision" && (explicit || lakebasePluginPresent),
    ...(!shouldResolve
      ? {
          skippedReason: mode === false ? ("disabled" as const) : ("no database plugin" as const),
        }
      : {}),
  };
}
