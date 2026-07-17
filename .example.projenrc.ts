/**
 * Example-workspace mixins for the dbx-tools dogfood monorepo.
 *
 * Kept separate from `.projenrc.ts` so the seed packages (AppKit, Mastra Code,
 * and the original demos) stay visually and logically distinct from engine
 * development under `workspaces/`.
 */
import { mixin, project as projectApi, projectPredicate } from "@dbx-tools/projen";

const examples = projectPredicate.hasPath("example-workspaces");

/** Mastra Code catalog pin used only by the example packages below. AppKit +
 * sdk-experimental are engine defaults (see DEFAULT_CATALOG), so no pin here. */
export function configureExampleCatalog(project: projectApi.DBXToolsNodeProject): void {
  project.pnpmWorkspace?.addCatalog("mastracode", "0.30.0");
  // mastracode@0.4.0 imports `vscode-jsonrpc/node.js`; v9 exports only `./node`.
  project.pnpmWorkspace?.addOverride("overrides.vscode-jsonrpc", "8.2.1");
  // mastracode 0.30.0 depends on zod 4 / date-fns 4; @mastra/* peers still list v3 ranges.
  project.pnpmWorkspace?.addOverride("peerDependencyRules.allowedVersions.zod", "4");
  project.pnpmWorkspace?.addOverride("peerDependencyRules.allowedVersions.date-fns", "4");
}

/** Example-workspace package mixins (private demos, AppKit, Mastra Code headless). */
export function applyExampleWorkspaces(project: projectApi.DBXToolsNodeProject): void {
  configureExampleCatalog(project);

  project.with(
    mixin.mixin(examples, (p) => {
      if (p instanceof projectApi.DBXToolsTypeScriptProject) p.package.addField("private", true);
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/shared-core"), projectPredicate.hasTag("shared")), (p) => {
      p.package.addField("name", "@dbx-tools/example-shared-core");
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/cli-main"), projectPredicate.hasTag("cli")), (p) => {
      p.package.addBin({ "pw-demo": "./src/cli.ts" });
      p.addDeps("@dbx-tools/example-shared-core@workspace:*", "@dbx-tools/shared-neat@workspace:*");
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/server-api"), projectPredicate.hasTag("server")), (p) => {
      p.addDeps("@dbx-tools/example-shared-core@workspace:*");
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/ui-app"), projectPredicate.hasTag("ui")), (p) => {
      p.addDeps("@dbx-tools/example-shared-core@workspace:*");
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/server-appkit-server"), projectPredicate.hasTag("server")), (p) => {
      p.addDeps("@databricks/appkit@catalog:");
      if (p instanceof projectApi.DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
      }
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/ui-appkit-client"), projectPredicate.hasTag("ui")), (p) => {
      p.addDeps("@databricks/appkit-ui@catalog:", "@databricks/appkit@catalog:");
      if (p instanceof projectApi.DBXToolsTypeScriptProject) {
        p.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
        p.tsconfig?.addInclude("index.ts");
      }
    })
    , mixin.mixin(examples.and(projectPredicate.hasName("*/cli-mastracode-headless"), projectPredicate.hasTag("cli")), (p) => {
      p.addDeps("mastracode@catalog:");
      p.package.addBin({
        mastracode: "./src/tui.ts",
        "mc-headless": "./src/headless.ts",
      });
      if (p instanceof projectApi.DBXToolsTypeScriptProject) {
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
    }));
}
