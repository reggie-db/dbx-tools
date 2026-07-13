import { existsSync } from "node:fs";
import react from "@vitejs/plugin-react";
import {
  defineConfig,
  mergeConfig,
  type ConfigEnv,
  type UserConfig,
  type UserConfigExport,
} from "vite";

// Unmanaged override modules (relative to this file), merged over the generated
// config in order - later wins, absent files are skipped.
const OVERRIDE_FILES = [
  "vite.config.override.js",
];

async function resolveConfig(
  config: UserConfigExport,
  env: ConfigEnv,
): Promise<UserConfig> {
  if (typeof config === "function") {
    return await config(env);
  }
  return await config;
}

export default defineConfig(async (configEnv: ConfigEnv) => {
  let config: UserConfig = {
    plugins: [react()],
  };

  for (const file of OVERRIDE_FILES) {
    const overrideUrl = new URL(file, import.meta.url);
    if (!existsSync(overrideUrl)) {
      continue;
    }
    const overrideModule = await import(overrideUrl.href);
    const override = await resolveConfig(
      overrideModule.default as UserConfigExport,
      configEnv,
    );
    config = mergeConfig(config, override);
  }

  return config;
});
