/**
 * Example-workspace mixins for the dbx-tools dogfood monorepo.
 *
 * Kept separate from `.projenrc.ts` so the seed packages (AppKit, Mastra Code,
 * and the original demos) stay visually and logically distinct from engine
 * development under `workspaces/`.
 */
import path from "node:path";
import { mixin } from "./workspaces/shared/projen/src/mixin";
import {
  DBXToolsNodeProject,
  DBXToolsTypeScriptProject,
  isDBXToolsPackage,
} from "./workspaces/shared/projen/src/package";
import { predicate } from "./workspaces/shared/core/index";

const EXAMPLE_WORKSPACES_ROOT = "example-workspaces";

function isExamplePackage(p: { root: { outdir: string }; outdir: string }): boolean {
  const rel = path.relative(p.root.outdir, p.outdir);
  return rel === EXAMPLE_WORKSPACES_ROOT || rel.startsWith(`${EXAMPLE_WORKSPACES_ROOT}/`);
}

/** AppKit + Mastra Code catalog pins used only by the example packages below. */
export function configureExampleCatalog(project: DBXToolsNodeProject): void {
  project.pnpmWorkspace?.addCatalog("@databricks/appkit", "^0.43.0");
  project.pnpmWorkspace?.addCatalog("@databricks/appkit-ui", "^0.43.0");
  project.pnpmWorkspace?.addCatalog("mastracode", "0.30.0");
  // mastracode@0.4.0 imports `vscode-jsonrpc/node.js`; v9 exports only `./node`.
  project.pnpmWorkspace?.addOverride("overrides.vscode-jsonrpc", "8.2.1");
}

/** Example-workspace package mixins (private demos, AppKit, Mastra Code headless). */
export function applyExampleWorkspaces(project: DBXToolsNodeProject): void {
  configureExampleCatalog(project);

  project.with(
    mixin(
      predicate.toPredicate(isDBXToolsPackage).and(isExamplePackage),
      (p) => p.package.addField("private", true),
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("shared"))
        .and((p) => p.packageIdentifier.name === "shared-core"),
      (p) => p.package.addField("name", "@dbx-tools/example-shared-core"),
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("cli"))
        .and((p) => p.packageIdentifier.name === "cli-main"),
      (p) => {
        p.package.addBin({ "pw-demo": "./src/cli.ts" });
        p.addDeps(
          "@dbx-tools/example-shared-core@workspace:*",
          "@dbx-tools/shared-neat@workspace:*",
        );
      },
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("server"))
        .and((p) => p.packageIdentifier.name === "server-api"),
      (p) => p.addDeps("@dbx-tools/example-shared-core@workspace:*"),
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("ui"))
        .and((p) => p.packageIdentifier.name === "ui-app"),
      (p) => p.addDeps("@dbx-tools/example-shared-core@workspace:*"),
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("server"))
        .and((p) => p.packageIdentifier.name === "server-appkit-server"),
      (p) => {
        p.addDeps("@databricks/appkit@catalog:");
        if (p instanceof DBXToolsTypeScriptProject) {
          p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
          p.tsconfig?.addInclude("index.ts");
        }
      },
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("ui"))
        .and((p) => p.packageIdentifier.name === "ui-appkit-client"),
      (p) => {
        p.addDeps("@databricks/appkit-ui@catalog:", "@databricks/appkit@catalog:");
        if (p instanceof DBXToolsTypeScriptProject) {
          p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
          p.tsconfig?.addInclude("index.ts");
        }
      },
    ),
    mixin(
      predicate
        .toPredicate(isDBXToolsPackage)
        .and(isExamplePackage)
        .and((p) => p.dbxToolsConfig.tags.includes("cli"))
        .and((p) => p.packageIdentifier.name === "cli-mastracode-headless"),
      (p) => {
        p.addDeps("mastracode@catalog:");
        p.package.addBin({ "mc-headless": "./src/headless.ts" });
        if (p instanceof DBXToolsTypeScriptProject) {
          p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
          p.tsconfig?.addInclude("index.ts");
          // Workspace self-bins are not linked into the package's own .bin; expose
          // a projen task so `pnpm mc-headless` works from this package directory.
          p.addTask("mc-headless", {
            exec: "tsx src/headless.ts",
            receiveArgs: true,
          });
        }
      },
    ),
  );
}
