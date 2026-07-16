/**
 * Example-workspace mixins for the dbx-tools dogfood monorepo.
 *
 * Kept separate from `.projenrc.ts` so the seed packages (AppKit, Mastra Code,
 * and the original demos) stay visually and logically distinct from engine
 * development under `workspaces/`.
 */
import {
  DBXToolsNodeProject,
  DBXToolsTypeScriptProject,
  inRelPath,
} from "./workspaces/shared/projen/src/project";

const examples = inRelPath("example-workspaces");

/** AppKit + Mastra Code catalog pins used only by the example packages below. */
export function configureExampleCatalog(project: DBXToolsNodeProject): void {
  project.pnpmWorkspace?.addCatalog("@databricks/appkit", "^0.43.0");
  project.pnpmWorkspace?.addCatalog("@databricks/appkit-ui", "^0.43.0");
  project.pnpmWorkspace?.addCatalog("mastracode", "0.30.0");
  // mastracode@0.4.0 imports `vscode-jsonrpc/node.js`; v9 exports only `./node`.
  project.pnpmWorkspace?.addOverride("overrides.vscode-jsonrpc", "8.2.1");
  // mastracode 0.30.0 depends on zod 4 / date-fns 4; @mastra/* peers still list v3 ranges.
  project.pnpmWorkspace?.addOverride("peerDependencyRules.allowedVersions.zod", "4");
  project.pnpmWorkspace?.addOverride("peerDependencyRules.allowedVersions.date-fns", "4");
}

/** Example-workspace package mixins (private demos, AppKit, Mastra Code headless). */
export function applyExampleWorkspaces(project: DBXToolsNodeProject): void {
  configureExampleCatalog(project);

  project
    .mixin(examples, (p) => {
      if (p instanceof DBXToolsTypeScriptProject) p.package.addField("private", true);
    })
    .mixin(examples.withTag("shared").supports("*/shared-core"), (p) => {
      p.package.addField("name", "@dbx-tools/example-shared-core");
    })
    .mixin(examples.withTag("cli").supports("*/cli-main"), (p) => {
      p.package.addBin({ "pw-demo": "./src/cli.ts" });
      p.addDeps("@dbx-tools/example-shared-core@workspace:*", "@dbx-tools/shared-neat@workspace:*");
    })
    .mixin(examples.withTag("server").supports("*/server-api"), (p) => {
      p.addDeps("@dbx-tools/example-shared-core@workspace:*");
    })
    .mixin(examples.withTag("ui").supports("*/ui-app"), (p) => {
      p.addDeps("@dbx-tools/example-shared-core@workspace:*");
    })
    .mixin(examples.withTag("server").supports("*/server-appkit-server"), (p) => {
      p.addDeps("@databricks/appkit@catalog:");
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
      }
    })
    .mixin(examples.withTag("ui").supports("*/ui-appkit-client"), (p) => {
      p.addDeps("@databricks/appkit-ui@catalog:", "@databricks/appkit@catalog:");
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
      }
    })
    .mixin(examples.withTag("cli").supports("*/cli-mastracode-headless"), (p) => {
      p.addDeps("mastracode@catalog:");
      p.package.addBin({
        mastracode: "./src/tui.ts",
        "mc-headless": "./src/headless.ts",
      });
      if (p instanceof DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
        p.addTask("mastracode", {
          exec: "tsx src/tui.ts",
          receiveArgs: true,
        });
        // Workspace self-bins are not linked into the package's own .bin; expose
        // projen tasks so `pnpm mastracode` / `pnpm mc-headless` work from here.
        p.addTask("mc-headless", {
          exec: "tsx src/headless.ts",
          receiveArgs: true,
        });
      }
    });
}
