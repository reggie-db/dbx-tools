/**
 * projen definition. The caller creates the projen project, configures any
 * non-auto-discovered packages with `applyEnv`, then hands the project to
 * `configureProjen` for folder-driven auto-discovery. pnpm-workspace.yaml sources
 * its members from `project.subprojects`, so BOTH the manual engine package and
 * the auto-discovered `workspaces/<env>/<name>` packages end up as members.
 */
import { javascript } from "projen";
import { configureProjen } from "./dbx-tools/src/projen/configure";
import type { EnvDef } from "./dbx-tools/src/projen/envs";
import { applyEnv } from "./dbx-tools/src/projen/packages";

const project = new javascript.NodeProject({
  // Empty name: the engine backfills it from the auto-detected repo identity
  // (`reggie-db/dbx-tools` -> `dbx-tools`), which also becomes the npm scope.
  name: "",
  defaultReleaseBranch: "main",
  // The engine is pnpm-only (it generates pnpm-workspace.yaml + catalog). projen's
  // packageManager is readonly after construction, so it must be set here.
  packageManager: javascript.NodePackageManager.PNPM,
  projenrcJs: false,
  buildWorkflow: false,
  release: false,
  jest: false,
  prettier: false,
  github: false,
  npmignoreEnabled: false,
  licensed: false,
  entrypoint: "",
  depsUpgrade: false,
  peerDependencyOptions: { pinnedDevDependency: false },
});

// The engine lives in-tree (imported by relative path above), so it is NOT installed
// as a dependency and its `dbxtools` bin is not linked. Expose the CLI as a
// `dbxtools` script that runs the source through tsx; `receiveArgs` forwards the
// subcommand, so `pnpm dbxtools <cmd>` (used by the generated `watch` task and
// interactively) works here. A repo consuming @dbx-tools/cli from npm omits this -
// there `pnpm dbxtools` resolves the package's linked bin.
project.addTask("dbxtools", {
  exec: "tsx dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

/**
 * The engine, configured MANUALLY (outside auto-discovery) with `applyEnv`. It is
 * a normal projen subproject like the auto-discovered ones - so it is sourced into
 * pnpm-workspace.yaml the same way - but lives at `dbx-tools/` (outside the
 * `workspaces/` env layout) and is named `@dbx-tools/cli` so it never collides with
 * the `dbx-tools` root project. Its env is Node with an include that also covers the
 * root `index.ts` barrel and the `bin/` CLI.
 */
const engineEnv: EnvDef = {
  deps: [
    "projen@^0.101.4",
    "constructs@^10.0.0",
    "barrelsby@^2.8.1",
    "chokidar@^4.0.3",
    "commander@catalog:",
    "consola@^3.4.2",
    "openapi-typescript@^7.13.0",
    "swagger-jsdoc@^6.2.8",
    "yaml@^2.9.0",
    "tsx@^4.23.0",
  ],
  // typescript is provided as a devDep by projen's TypeScriptProject; pin it here.
  typescriptVersion: "^5.9.3",
  devDeps: ["@types/node@catalog:", "@types/swagger-jsdoc@^6.0.4"],
  tsconfig: {
    include: ["index.ts", "bin/**/*.ts", "src/**/*.ts"],
    compilerOptions: { target: "ES2022", lib: ["ES2022"], types: ["node"], rootDir: "." },
  },
};

applyEnv(project, {
  outdir: "dbx-tools",
  name: "@dbx-tools/cli",
  env: engineEnv,
  workspace: (pkg) => pkg.package.addBin({ dbxtools: "./bin/dbxtools.ts" }),
});

configureProjen(project, {
  // The single place per-package tweaks belong; everything else is auto-detected.
  // `pkg` is the real projen subproject (edits use projen's own API); dispatch on
  // the STABLE folder identity `spec.env`/`spec.name`, not the derived package name.
  workspace(pkg, spec) {
    if (spec.env === "ui" && spec.name === "app") {
      pkg.addDeps("@dbx-tools/shared-core@workspace:*");
    } else if (spec.env === "server" && spec.name === "api") {
      pkg.addDeps("@dbx-tools/shared-core@workspace:*", "express@catalog:");
      pkg.addDevDeps("@types/express@catalog:");
      pkg.addTask("dev", { exec: "tsx watch src/server.ts" });
      pkg.addTask("start", { exec: "tsx src/server.ts" });
    } else if (spec.env === "cli" && spec.name === "main") {
      pkg.package.addBin({ "pw-demo": "./src/cli.ts" });
      pkg.addDeps("@dbx-tools/shared-core@workspace:*", "@dbx-tools/shared-neat@workspace:*");
    }
  },
});

project.synth();
