/**
 * projen definition. `new DBXToolsNodeProject(...)` constructs the monorepo root
 * and, from its `workspacePackageRoots`, scans + attaches a
 * `DBXToolsTypeScriptProject` per `<tag>/<name>/src` folder under `workspaces/`
 * (real content) and `example-workspaces/` (the seed examples this repo ships,
 * kept separate). The engine itself is dogfooded as a normal auto-discovered `cli`
 * package at `workspaces/cli/dbx-tools`; the `cli`/`dbx-tools` mixin below renames
 * it from the auto-derived `@dbx-tools/cli-dbx-tools` to the clean `@dbx-tools/cli`.
 *
 * Per-package tweaks are MIXINS applied with `project.with(...)` (constructs-
 * native, across the subtree; the built-in tag mixins already ran during
 * construction). `synth()` is called manually because this repo adds a `dbxtools`
 * root task first (see below); a normal consumer constructs, `with(...)`s, synths.
 */
import path, { basename } from "node:path";
import { packageMixin } from "./workspaces/cli/dbx-tools/src/projen/mixins";
import { DBXToolsNodeProject } from "./workspaces/cli/dbx-tools/src/projen/project";

const EXAMPLE_WORKSPACES_ROOT = "example-workspaces";
const CLI_PACKAGE_DIR = "workspaces/cli/dbx-tools";

const project = new DBXToolsNodeProject({
  scope: "dbx-tools",
  // `workspaces/` is the default; `example-workspaces/` is this repo's own addition
  // so seed content stays visually separate from real content added later.
  workspacePackageRoots: ["workspaces", EXAMPLE_WORKSPACES_ROOT],
  github: true,
  buildWorkflow: true,
  release: true,
  releaseToNpm: true,
  workflowPackageCache: true,
  depsUpgrade: false,
});



// Per-package tweaks are user MIXINS applied across the subtree with the
// constructs-native `project.with(...)` - it runs each mixin over the current tree
// (captured at call time), after the built-in tag mixins the root already applied
// during construction. Each dispatches on the STABLE folder identity: the
// package's resolved tags + its folder name (not the derived npm name).
project.with(
  packageMixin(
    (p) => {
      const outdirRelativeToRoot = path.relative(project.root.outdir, p.outdir)
      const exampleWorkspace = outdirRelativeToRoot == (EXAMPLE_WORKSPACES_ROOT) || outdirRelativeToRoot.startsWith(EXAMPLE_WORKSPACES_ROOT + "/")
      return exampleWorkspace
    },
    (p) => p.package.addField("private", true),
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("ui") && basename(p.outdir) === "app",
    (p) => {
      p.addDeps("@dbx-tools/shared-core@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("server") && basename(p.outdir) === "api",
    (p) => {
      // express + dev/start come from the built-in `server` tag mixin (tags.ts).
      p.addDeps("@dbx-tools/shared-core@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "main",
    (p) => {
      p.package.addBin({ "pw-demo": "./src/cli.ts" });
      p.addDeps("@dbx-tools/shared-core@workspace:*", "@dbx-tools/shared-neat@workspace:*");
    },
  ),
  packageMixin(
    (p) => p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "dbx-tools",
    (p) => {
      p.dbxToolsConfig.lockPackageJson = false
      // The engine, dogfooded through the normal `cli` tag. Override the
      // auto-derived name (`@dbx-tools/cli-dbx-tools`) to the clean `@dbx-tools/cli`.
      p.package.addField("name", "@dbx-tools/cli");
      p.package.addField("publishConfig", { access: "public", provenance: true });
      p.package.addField("cool-dude", "0.0.0");
      p.package.addBin({ dbxtools: "./bin/dbxtools.ts" });
      // `commander` + `@types/node` already come from the `cli` tag; the rest are
      // the engine's own deps. `pnpm` here is what lets `dbxtools sync` bootstrap a
      // brand-new, completely empty folder with no global pnpm install required -
      // it resolves pnpm's own CLI via `require.resolve`, not a system PATH lookup.
      p.addDeps(
        "projen",
        "constructs",
        "barrelsby",
        "chokidar",
        "consola",
        "openapi-typescript",
        "tsoa",
        "yaml",
        "tsx",
        "pnpm",
        "tinyglobby",
        "picomatch",
        "p-memoize",
      );
      p.addDevDeps("@types/picomatch@^4.0.3");
      // ES2022 stdlib (e.g. Object.hasOwn in the logger) - the `cli` tag default is
      // ES2020. Also cover the root `index.ts` barrel and the `bin/` CLI, which the
      // tag's default `src/**/*.ts` include doesn't reach - widening `rootDir` to
      // the package root avoids TS6059 ("not under rootDir") for both.
      p.tsconfig?.file.addOverride("compilerOptions.target", "ES2022");
      p.tsconfig?.file.addOverride("compilerOptions.lib", ["ES2022"]);
      p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
      p.tsconfig?.addInclude("index.ts");
      p.tsconfig?.addInclude("bin/**/*.ts");
    },
  ),
);



// The engine lives in-tree (imported by relative path above) as an auto-discovered
// workspace package, so it is NOT installed as a dependency and its `dbxtools` bin
// is not linked at the root. Expose the CLI as a `dbxtools` script that runs the
// source through tsx; `receiveArgs` forwards the subcommand, so `pnpm dbxtools
// <cmd>` (used by the generated `sync` task and interactively) works here. A repo
// consuming `@dbx-tools/cli` from npm omits this - there `pnpm dbxtools` resolves
// the installed package's linked bin.
project.addTask("dbxtools", {
  exec: "tsx workspaces/cli/dbx-tools/bin/dbxtools.ts",
  receiveArgs: true,
});

// CI/release: type-check every workspace package, then pack the publishable CLI
// tarball into the root `dist/js` artifact projen's release workflow uploads.
project.compileTask.reset("pnpm -r compile");
project.packageTask.reset(
  `node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const version = JSON.parse(readFileSync('package.json', 'utf8')).version; const pkgPath = '${CLI_PACKAGE_DIR}/package.json'; const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); pkg.version = version; writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n');" && mkdir -p dist/js && pnpm --dir ${CLI_PACKAGE_DIR} pack --pack-destination ../../../dist/js`,
);

project.synth();
