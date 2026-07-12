/**
 * projen definition for the monorepo.
 *
 * All the machinery lives in `@dbx-tools/projen-config`
 * (`packages/dbx-tools/projen-config`), exported as `configureProjen`. Scopes
 * are applied automatically from folder names under `packages/` - see the
 * engine's `SCOPE_PROFILES` (ui / cli / server / shared / node, plus the
 * generated `openapi` scope and `dbx-tools` for the engine). Packages listed
 * here are only *overrides* (deps, bin, scripts); a folder with no entry (e.g.
 * `packages/shared/core`) is configured purely from its scope's profile.
 */
import { configureProjen } from "./packages/dbx-tools/projen-config/src/configure";
import type { PackageSpec } from "./packages/dbx-tools/projen-config/src/packages";

/** Optional overrides. shared/core and the generated openapi/* need none. */
const PACKAGES: PackageSpec[] = [
  // The engine itself (dbx-tools scope -> node profile). Its `dbxtools` bin is
  // the single CLI the projen tasks call.
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
      "swagger-jsdoc": "catalog:",
      "openapi-typescript": "catalog:",
      tsx: "^4.23.0",
      typescript: "catalog:",
    },
    devDependencies: { "@types/swagger-jsdoc": "catalog:" },
  },

  // server scope -> node profile; add Express + the shared lib.
  {
    scope: "server",
    name: "api",
    dependencies: { "@dbx-tools/shared-core": "workspace:*", express: "catalog:" },
    devDependencies: { "@types/express": "catalog:" },
    scripts: { dev: "tsx watch src/server.ts", start: "tsx src/server.ts" },
  },

  // cli scope -> cli profile (auto commander + @clack/prompts); add a bin.
  {
    scope: "cli",
    name: "main",
    bin: { "pw-demo": "./src/cli.ts" },
    dependencies: { "@dbx-tools/shared-core": "workspace:*" },
  },

  // ui scope -> vite profile (auto react + vite + vite.config + dev/build scripts).
  {
    scope: "ui",
    name: "app",
    private: true,
    noExports: true,
    dependencies: { "@dbx-tools/shared-core": "workspace:*" },
  },
];

configureProjen({
  name: "projen-workspace",
  // Root npm scope for generated package names (@dbx-tools/<scope>-<name>).
  // Set now so it survives the eventual folder rename to `dbx-tools`.
  scope: "dbx-tools",
  packages: PACKAGES,
}).synth();
