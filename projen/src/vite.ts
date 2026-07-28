/**
 * `vite.config.ts` as a first-class projen file component.
 *
 * {@link ViteConfigFile} extends projen's `TextFile` and emits a generated,
 * read-only Vite config: the React plugin plus a runtime OVERRIDE chain. At Vite
 * startup the generated config looks for each unmanaged override module sitting
 * beside it (see {@link DEFAULT_VITE_OVERRIDES}) and, when present, merges that
 * module's default export over the generated config with Vite's `mergeConfig` - in
 * listed order, so later files win and absent ones are skipped. A package thus
 * tweaks Vite WITHOUT editing the projen-owned file.
 *
 * An override may be written in TypeScript or JavaScript. The generated config
 * reaches it through a dynamic `import()` of a runtime-computed URL, which Vite's
 * config bundling cannot inline and so leaves for Node to execute - and Node
 * strips types from a `.ts` file outside `node_modules` on its own. Being a
 * package-ROOT file (not under `src/`), neither the generated `vite.config.ts`
 * nor the override is in the package's `tsconfig` `include`, so their `node:*`
 * usage never trips the `ui` package's `compile` under the DOM-only tsconfig.
 */
import { type Project, TextFile } from "projen";

/**
 * Default unmanaged override modules, merged over the generated config in order
 * (later wins, absent files skipped). Both extensions are accepted so an existing
 * JavaScript override keeps working; the TypeScript one is listed last so it wins
 * where a package is mid-migration and still has both.
 *
 * Exported because ESLint has to ignore them: an override is a package-ROOT file
 * outside any `src/**` tsconfig include, so the type-aware parser cannot resolve
 * it to a project - the same reason the generated `vite.config.ts` is ignored.
 */
export const DEFAULT_VITE_OVERRIDES = ["vite.config.override.js", "vite.config.override.ts"];

/** Render the generated `vite.config.ts` source with the override chain inlined. */
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
`.trimStart();
}

/**
 * A projen-owned, read-only `vite.config.ts` (React + the runtime override merge
 * chain described in the module docstring).
 */
export class ViteConfigFile extends TextFile {
  constructor(project: Project) {
    super(project, "vite.config.ts", {
      marker: true,
      readonly: true,
      lines: renderViteConfig(DEFAULT_VITE_OVERRIDES).split("\n"),
    });
  }
}
