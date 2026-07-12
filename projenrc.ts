/**
 * projen definition for the `projen-workspace` monorepo.
 *
 * All the machinery lives in `@dbx-tools/projen-config`
 * (`packages/dbx-tools/projen-config`), exported as `configureProjen` so the
 * same scope-enforcing / barrel / auto-scaffold setup can be published to npm
 * and reused from any other repo. This file just declares *this* repo's
 * packages and calls it.
 *
 * Named `projenrc.ts` (no leading dot) so macOS shows it; projen picks it up via
 * `ProjenrcTs({ filename })`. Imported by relative path (not the
 * `@dbx-tools/projen-config` alias) so the very first `tsx projenrc.ts` works
 * before the workspace is linked.
 */
import { configureProjen } from "./packages/dbx-tools/projen-config/src/configure";
import type { PackageSpec } from "./packages/dbx-tools/projen-config/src/packages";

/**
 * This repo's packages. Scopes map to enforcement profiles in the engine's
 * `SCOPES`: client->vite, ui->react, dom->dom, shared->agnostic,
 * server->node, cli->cli, dbx-tools->node. A `packages/<scope>/<name>/src`
 * folder that isn't listed here is auto-scaffolded (see the `scaffold` task) and
 * gets a generated name `@projen-workspace/<scope>-<name>`.
 */
const PACKAGES: PackageSpec[] = [
  // The engine itself, dogfooded. Node profile (dbx-tools scope). Its `dbxtools`
  // bin is the single CLI the projen tasks call.
  {
    scope: "dbx-tools",
    name: "projen-config",
    tsconfigInclude: ["index.ts", "src", "bin", "test"],
    bin: { dbxtools: "./bin/dbxtools.ts" },
    dependencies: {
      projen: "^0.101.4",
      constructs: "^10.0.0",
      barrelsby: "^2.8.1",
      chokidar: "^4.0.3",
      commander: "catalog:",
      consola: "catalog:",
      tsx: "^4.23.0",
      typescript: "catalog:",
    },
  },

  // agnostic --------------------------------------------------------------
  { scope: "shared", name: "core" },

  // node ------------------------------------------------------------------
  {
    scope: "server",
    name: "api",
    dependencies: { "@shared/core": "workspace:*" },
    scripts: { dev: "tsx watch src/server.ts", start: "tsx src/server.ts" },
  },

  // cli (node + commander + @clack/prompts, injected by the profile) ------
  {
    scope: "cli",
    name: "main",
    bin: { "pw-demo": "./src/cli.ts" },
    dependencies: { "@shared/core": "workspace:*" },
  },

  // dom -------------------------------------------------------------------
  { scope: "dom", name: "util" },

  // react -----------------------------------------------------------------
  { scope: "ui", name: "components", dependencies: { "@shared/core": "workspace:*" } },

  // vite ------------------------------------------------------------------
  {
    scope: "client",
    name: "app",
    private: true,
    noExports: true,
    dependencies: {
      "@shared/core": "workspace:*",
      "@ui/components": "workspace:*",
    },
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
  },
];

configureProjen({
  name: "projen-workspace",
  packages: PACKAGES,
  // Hook to tweak any generated package.json before it's written, e.g.:
  // packageModifier: (m) => ({ ...m, author: "Reggie Pierce" }),
}).synth();
