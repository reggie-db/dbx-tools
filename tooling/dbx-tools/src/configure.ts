/**
 * `configureProjen(project, options)` - taps into a projen `NodeProject` the
 * caller already created and turns it into a scope-enforcing pnpm monorepo.
 *
 * Everything is auto-detected from folders: any `packages/<scope>/<name>` is
 * configured from its scope (see `./scopes`). Per-package tweaks go in the
 * `modifyPackage` / `modifyTsconfig` hooks. The engine (`tooling/dbx-tools`) is
 * NOT under `packages/`, so it is never auto-configured - consumers install it
 * from npm as `dbx-tools`.
 */
import { fileURLToPath } from "node:url";
import { JsonFile, type javascript, typescript } from "projen";
import { DISCOVERED_FILE } from "./discovered";
import * as files from "./files";
import {
  type ModifyPackage,
  type ModifyTsconfig,
  definePackage,
  npmNameOf,
} from "./packages";
import { SCOPES, type Scope, type ScopeDef } from "./scopes";
import { discoverPackagesOnDisk, projectName } from "./workspace";

/** Default pnpm `catalog:` versions, pinned to match `databricks apps init` (AppKit). */
export const DEFAULT_CATALOG: Record<string, string> = {
  react: "^19.2.4",
  "react-dom": "^19.2.4",
  "@types/react": "^19.2.2",
  "@types/react-dom": "^19.2.2",
  vite: "^7.1.14",
  "@vitejs/plugin-react": "^5.0.4",
  "@types/node": "^24.6.0",
  "@types/express": "^5.0.5",
  express: "^5.1.0",
  zod: "^4.3.6",
  typescript: "^5.9.3",
  commander: "^15.0.0",
  "@clack/prompts": "^1.7.0",
  "openapi-fetch": "^0.17.0",
};

/** Where the `dbxtools` CLI lives, repo-relative (in-repo vs installed from npm). */
function defaultBinDir(): string {
  const here = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  return here.includes("/node_modules/")
    ? "node_modules/dbx-tools/bin"
    : "tooling/dbx-tools/bin";
}

export interface ConfigureProjenOptions {
  /** Root npm scope for generated names; defaults to the project name. `""` = unscoped. */
  readonly scope?: string;
  /** Scope -> config map. Defaults to the built-in {@link SCOPES}. */
  readonly scopes?: Record<string, ScopeDef>;
  /** Auto-scopes to turn off (their folders fall back to the default config). */
  readonly disableScopes?: Scope[];
  /** pnpm `catalog:` versions. Defaults to {@link DEFAULT_CATALOG}. */
  readonly catalog?: Record<string, string>;
  /** Per-package hook to tweak the generated `package.json`. */
  readonly modifyPackage?: ModifyPackage;
  /** Per-package hook to tweak the generated `tsconfig.json`. */
  readonly modifyTsconfig?: ModifyTsconfig;
  /** Repo-relative dir holding the `dbxtools` CLI. Auto-detected by default. */
  readonly binDir?: string;
}

/** Tap into a caller-created project. Returns it (caller runs `.synth()`). */
export function configureProjen(
  project: javascript.NodeProject,
  options: ConfigureProjenOptions = {},
): javascript.NodeProject {
  const {
    scope,
    scopes = SCOPES,
    disableScopes = [],
    catalog = DEFAULT_CATALOG,
    modifyPackage,
    modifyTsconfig,
    binDir = defaultBinDir(),
  } = options;

  const rootScope = scope ?? project.name ?? projectName();
  const effectiveScopes: Record<string, ScopeDef> = { ...scopes };
  for (const s of disableScopes) delete effectiveScopes[s];

  // Run `.projenrc.ts` through tsx.
  new typescript.ProjenrcTs(project, { runner: typescript.TypeScriptRunner.tsx() });
  project.defaultTask?.reset("tsx .projenrc.ts");

  // Root devDeps the toolchain needs (onchange = the watch library; dbx-tools = engine).
  project.addDevDeps(
    "tsx@^4.23.0",
    "typescript@^5.9.3",
    "@types/node@^24.6.0",
    "onchange@^7.1.0",
    "dbx-tools@workspace:*",
  );

  const pkg = project.package;
  pkg.addField("type", "module");
  pkg.addField("private", true);

  // The ONLY projen task: repurpose projen's `watch` (like projen does for cdk/
  // jsii) into a library watcher (onchange) running the `dbxtools sync` one-shot.
  // Everything else is a `dbxtools` bin subcommand - no `projen`-calling scripts.
  const cli = `${binDir}/dbxtools.ts`;
  const watch = project.tasks.tryFind("watch") ?? project.addTask("watch");
  watch.reset(
    `onchange -i -d 250 -e "packages/openapi/**" "packages/*/*/src/**/*.{ts,tsx,js}" -- tsx ${cli} sync`,
  );

  // Root config files (all projen-owned: read-only + generated marker).
  files.pnpmWorkspace(project, catalog);
  files.tsconfigBase(project);
  files.tsconfigRoot(project);
  files.prettierConfig(project);
  files.prettierIgnore(project);
  files.vscodeTasks(project); // folderOpen -> `projen watch` -> onchange -> dbxtools sync
  files.vscodeSettings(project);
  files.vscodeExtensions(project);

  // Per-package manifests: purely auto-detected folders (engine lives in tooling/).
  for (const p of discoverPackagesOnDisk()) {
    definePackage(
      project,
      { scope: p.scope, name: p.name },
      { scopes: effectiveScopes, rootScope, modifyPackage, modifyTsconfig },
    );
  }

  // A read-only, projen-owned record of the auto-detected packages.
  const discovered = discoverPackagesOnDisk().map((p) => ({
    scope: p.scope,
    name: p.name,
    packageName: npmNameOf({ scope: p.scope, name: p.name }, rootScope),
  }));
  new JsonFile(project, DISCOVERED_FILE, {
    marker: true,
    readonly: true,
    obj: { packages: discovered },
  });

  project.gitignore.addPatterns(
    ".DS_Store",
    "dist",
    "**/dist",
    "*.tsbuildinfo",
    "node_modules/.cache",
    ".env",
    "tmp",
  );

  return project;
}
