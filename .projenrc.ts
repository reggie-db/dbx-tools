/**
 * projen definition. `configureProjen` constructs the `NodeProject` itself,
 * merging its own opinionated defaults with any `extends` overrides passed
 * here, then auto-discovers `<env>/<name>` packages under `workspaces/` (real
 * content) and `example-workspaces/` (the seed examples this repo ships, kept
 * visually separate). The engine itself is dogfooded as a normal
 * auto-discovered `cli` package at `workspaces/cli/dbx-tools` - its
 * `workspacePackage()` branch below just renames it from the auto-derived
 * `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 */
import { configureProjen } from "./workspaces/cli/dbx-tools/src/projen/configure";

const project = configureProjen({
  // `workspaces/` is the default; `example-workspaces/` is this repo's own addition
  // so seed content stays visually separate from real content added later.
  workspacePackageRoots: ["workspaces", "example-workspaces"],
  // The single place per-package tweaks belong; everything else is auto-detected.
  // `pkg` is the real projen subproject (edits use projen's own API); dispatch on
  // the STABLE folder identity `spec.tags`/`spec.name`, not the derived package name.
  workspacePackage(pkg, spec) {
    if (spec.tags.includes("ui") && spec.name === "app") {
      pkg.addDeps("@dbx-tools/shared-core@workspace:*");
    } else if (spec.tags.includes("server") && spec.name === "api") {
      pkg.addDeps("@dbx-tools/shared-core@workspace:*", "express@catalog:");
      pkg.addDevDeps("@types/express@catalog:");
      pkg.addTask("dev", { exec: "tsx watch src/server.ts" });
      pkg.addTask("start", { exec: "tsx src/server.ts" });
    } else if (spec.tags.includes("cli") && spec.name === "main") {
      pkg.package.addBin({ "pw-demo": "./src/cli.ts" });
      pkg.addDeps("@dbx-tools/shared-core@workspace:*", "@dbx-tools/shared-neat@workspace:*");
    } else if (spec.tags.includes("cli") && spec.name === "dbx-tools") {
      // The engine, dogfooded through the normal `cli` env. Override the
      // auto-derived name (`@dbx-tools/cli-dbx-tools`) to the clean `@dbx-tools/cli`.
      pkg.package.addField("name", "@dbx-tools/cli");
      pkg.package.addBin({ dbxtools: "./bin/dbxtools.ts" });
      // `commander` + `@types/node` already come from the `cli` env; the rest are
      // the engine's own deps. `pnpm` here is what lets `dbxtools sync` bootstrap a
      // brand-new, completely empty folder with no global pnpm install required -
      // it resolves pnpm's own CLI via `require.resolve`, not a system PATH lookup.
      pkg.addDeps(
        "projen@^0.101.4",
        "constructs@^10.0.0",
        "barrelsby@^2.8.1",
        "chokidar@^4.0.3",
        "consola@^3.4.2",
        "openapi-typescript@^7.13.0",
        "tsoa@catalog:",
        "yaml@^2.9.0",
        "tsx@^4.23.0",
        "pnpm@catalog:",
      );
      // ES2022 stdlib (e.g. Object.hasOwn in the logger) - the `cli` env default is
      // ES2020. Also cover the root `index.ts` barrel and the `bin/` CLI, which the
      // env's default `src/**/*.ts` include doesn't reach - widening `rootDir` to
      // the package root avoids TS6059 ("not under rootDir") for both.
      pkg.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
      pkg.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
      pkg.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
      pkg.tsconfig?.addInclude("index.ts");
      pkg.tsconfig?.addInclude("bin/**/*.ts");
    }
  },
});

// The engine lives in-tree (imported by relative path above) as an auto-discovered
// workspace package, so it is NOT installed as a dependency and its `dbxtools` bin
// is not linked at the root. Expose the CLI as a `dbxtools` script that runs the
// source through tsx; `receiveArgs` forwards the subcommand, so `pnpm dbxtools
// <cmd>` (used by the generated `watch` task and interactively) works here. A repo
// consuming `@dbx-tools/cli` from npm omits this - there `pnpm dbxtools` resolves
// the installed package's linked bin.
project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

project.synth();
