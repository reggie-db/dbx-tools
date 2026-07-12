/**
 * projen definition. The caller creates the projen project and passes it to
 * `configureProjen` (from the `dbx-tools` engine in `tooling/dbx-tools`), which
 * taps into it: scopes are applied automatically from folder names under
 * `packages/`; the only per-package config lives in the `modifyPackage` hook.
 */
import { javascript } from "projen";
import { configureProjen } from "./tooling/dbx-tools/src/configure";
import type { PackageManifest } from "./tooling/dbx-tools/src/packages";

const project = new javascript.NodeProject({
  name: "dbx-tools-workspace",
  defaultReleaseBranch: "main",
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

const addDeps = (m: PackageManifest, deps: Record<string, string>): void => {
  m.dependencies = { ...(m.dependencies as Record<string, string> | undefined), ...deps };
};

configureProjen(project, {
  scope: "dbx-tools",
  // The single place per-package tweaks belong; everything else is auto-detected.
  modifyPackage(_scope, m) {
    switch (m.name) {
      case "@dbx-tools/ui-app":
        m.private = true;
        delete m.exports;
        addDeps(m, { "@dbx-tools/shared-core": "workspace:*" });
        break;
      case "@dbx-tools/server-api":
        addDeps(m, { "@dbx-tools/shared-core": "workspace:*", express: "catalog:" });
        m.devDependencies = {
          ...(m.devDependencies as Record<string, string> | undefined),
          "@types/express": "catalog:",
        };
        m.scripts = { dev: "tsx watch src/server.ts", start: "tsx src/server.ts" };
        break;
      case "@dbx-tools/cli-main":
        m.bin = { "pw-demo": "./src/cli.ts" };
        addDeps(m, { "@dbx-tools/shared-core": "workspace:*" });
        break;
    }
    return m;
  },
});

project.synth();
