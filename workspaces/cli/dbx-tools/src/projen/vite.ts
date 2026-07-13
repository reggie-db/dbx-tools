/**
 * `vite.config.ts` as a first-class projen file component.
 *
 * {@link ViteConfigFile} extends projen's `TextFile` and emits a generated,
 * read-only Vite config: the React plugin plus a runtime OVERRIDE chain. At Vite
 * startup the generated config looks for each unmanaged override module sitting
 * beside it (default {@link DEFAULT_VITE_OVERRIDES}: `vite.config.custom.js` then
 * `vite.config.override.js`) and, when present, merges that module's default export
 * over the generated config with Vite's `mergeConfig` - in listed order, so later
 * files win and absent ones are skipped. A package thus tweaks Vite WITHOUT editing
 * the projen-owned file; pass `overridePaths` to change the chain.
 *
 * The override modules are `.js` because Vite loads them via a plain dynamic
 * `import()` at config time. Being a package-ROOT file (not under `src/`), the
 * generated `vite.config.ts` is excluded from the package's `tsconfig` `include`, so
 * its `node:*` usage never trips `dbxtools typecheck` under the DOM-only `ui`
 * tsconfig; Vite transpiles it with esbuild and runs it in Node at config time.
 */
import { type Project, TextFile, typescript } from "projen";

/**
 * Default unmanaged override modules, merged over the generated config in order
 * (later wins, absent files skipped): a package's `vite.config.custom.js` then
 * `vite.config.override.js`.
 */
export const DEFAULT_VITE_OVERRIDES = ["vite.config.override.js"];

/** Options for {@link ViteConfigFile}. */
export interface ViteConfigFileOptions {
  /**
   * Unmanaged override modules (relative to the generated `vite.config.ts`) whose
   * default export is merged over the generated config at Vite startup, in order -
   * later entries win, absent files are skipped. Defaults to
   * {@link DEFAULT_VITE_OVERRIDES}.
   */
  readonly overridePaths?: string[];
}

/** Render the generated `vite.config.ts` source with `overridePaths` inlined. */
function renderViteConfig(overridePaths: string[]): string {
  const overrides = overridePaths.map((path) => `  ${JSON.stringify(path)},`).join("\n");
  return String.raw`
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
${overrides}
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

export default defineConfig(async (env) => {
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
      env,
    );
    config = mergeConfig(config, override);
  }

  return config;
});
`.trimStart();
}

/**
 * A projen-owned, read-only `vite.config.ts` (React + the runtime override merge
 * chain described in the module docstring).
 */
export class ViteConfigFile extends TextFile {
  constructor(project: Project, options: ViteConfigFileOptions = {}) {
    super(project, "vite.config.ts", {
      marker: true,
      readonly: true,
      lines: renderViteConfig(options.overridePaths ?? DEFAULT_VITE_OVERRIDES).split("\n"),
    });
  }
}

/**
 * Emit a package's read-only `vite.config.ts` via {@link ViteConfigFile}.
 * Idempotent: a package that already has one (e.g. the `viteConfig` option and the
 * `ui` tag mixin both firing) is left untouched.
 */
export function emitViteConfig(
  pkg: typescript.TypeScriptProject,
  options?: ViteConfigFileOptions,
): void {
  if (pkg.tryFindFile("vite.config.ts")) return;
  new ViteConfigFile(pkg, options);
}
