/**
 * projen definition. The caller creates the projen project and passes it to
 * `configureProjen` (from the in-tree `dbx-tools` engine), which taps into it:
 * workspace envs are applied automatically from folder names under the
 * `workspaceEnvPaths` roots (default `workspaces/`); the only per-package config
 * lives in the `modifyPackage` hook.
 */
import { javascript } from "projen";
import { configureProjen } from "./dbx-tools/src/projen/configure";

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
// interactively) works here. A repo consuming dbx-tools from npm omits this - there
// `pnpm dbxtools` resolves the package's bin.
project.addTask("dbxtools", {
  exec: "tsx dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

configureProjen(project, {
  // This repo keeps the dbx-tools engine in-tree, so it is an extra workspace
  // member on top of the auto-discovered env packages (and its `src` is watched
  // for re-synth). A repo consuming dbx-tools from npm omits this.
  additionalWorkspaces: ["dbx-tools"],
  // The single place per-package tweaks belong; everything else is auto-detected.
  // `pkg` is the real projen subproject (edits use projen's own API); dispatch on
  // the STABLE folder identity `spec.env`/`spec.name`, not the derived package name.
  modifyPackage(pkg, spec) {
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
