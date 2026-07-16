/**
 * Example-workspace mixins for the dbx-tools dogfood monorepo.
 *
 * Kept separate from `.projenrc.ts` so the seed packages (AppKit, Mastra Code,
 * and the original demos) stay visually and logically distinct from engine
 * development under `workspaces/`.
 */
import path, { basename } from "node:path";
import type { javascript } from "projen";
import { packageMixin } from "./workspaces/shared/projen/src/mixins";
import {
  DBXToolsNodeProject,
  DBXToolsTypeScriptProject,
} from "./workspaces/shared/projen/src/project";

const EXAMPLE_WORKSPACES_ROOT = "example-workspaces";

function isExamplePackage(p: javascript.NodeProject): boolean {
  const root = p.root.outdir;
  const rel = path.relative(root, p.outdir);
  return rel === EXAMPLE_WORKSPACES_ROOT || rel.startsWith(`${EXAMPLE_WORKSPACES_ROOT}/`);
}

/** AppKit + Mastra Code catalog pins used only by the example packages below. */
export function configureExampleCatalog(project: DBXToolsNodeProject): void {
  project.pnpmWorkspace?.addCatalog("@databricks/appkit", "^0.43.0");
  project.pnpmWorkspace?.addCatalog("@databricks/appkit-ui", "^0.43.0");
  project.pnpmWorkspace?.addCatalog("mastracode", "^0.4.0");
}

/** Example-workspace package mixins (private demos, AppKit, Mastra Code headless). */
export function applyExampleWorkspaces(project: DBXToolsNodeProject): void {
  configureExampleCatalog(project);

  project.with(
    packageMixin(isExamplePackage, (p) => p.package.addField("private", true)),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("shared") && basename(p.outdir) === "core",
      (p) => p.package.addField("name", "@dbx-tools/example-shared-core"),
    ),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "main",
      (p) => {
        p.package.addBin({ "pw-demo": "./src/cli.ts" });
        p.addDeps(
          "@dbx-tools/example-shared-core@workspace:*",
          "@dbx-tools/shared-neat@workspace:*",
        );
      },
    ),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("server") && basename(p.outdir) === "api",
      (p) => p.addDeps("@dbx-tools/example-shared-core@workspace:*"),
    ),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("ui") && basename(p.outdir) === "app",
      (p) => p.addDeps("@dbx-tools/example-shared-core@workspace:*"),
    ),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("server") && basename(p.outdir) === "appkit-server",
      (p) => {
        p.addDeps("@databricks/appkit@catalog:");
        if (p instanceof DBXToolsTypeScriptProject) {
          p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
          p.tsconfig?.addInclude("index.ts");
        }
      },
    ),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("ui") && basename(p.outdir) === "appkit-client",
      (p) => {
        p.addDeps("@databricks/appkit-ui@catalog:", "@databricks/appkit@catalog:");
        if (p instanceof DBXToolsTypeScriptProject) {
          p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
          p.tsconfig?.addInclude("index.ts");
        }
      },
    ),
    packageMixin(
      (p) => isExamplePackage(p) && p.dbxToolsConfig.tags.includes("cli") && basename(p.outdir) === "mastracode-headless",
      (p) => {
        p.addDeps("mastracode@catalog:");
        p.package.addBin({ "mc-headless": "./src/headless.ts" });
        if (p instanceof DBXToolsTypeScriptProject) {
          p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
          p.tsconfig?.addInclude("index.ts");
        }
      },
    ),
  );
}
