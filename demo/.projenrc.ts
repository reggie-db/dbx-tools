/**
 * Standalone projen root for the runnable dbx-tools sample app.
 *
 * This is a self-contained downstream CONSUMER of the published `@dbx-tools/*`
 * packages: it has its own pnpm workspace and pulls the engine + feature
 * packages from a registry (see `.npmrc`), exactly as any external app would.
 * It is intentionally tiny - the whole app is two small packages:
 *
 *   - `server/appkit-demo` (`server` tag): an AppKit `createApp` server that
 *     mounts the Mastra agent, Genie, email, and Lakebase plugins.
 *   - `app/appkit-demo` (`app` tag): a React/Vite browser client that drops in
 *     `<MastraChat/>` from `@dbx-tools/ui-mastra`.
 *
 * Everything else - streaming, Genie tools, approval-gated email, memory, the
 * model picker, history, and threads - comes from the `@dbx-tools/*` packages;
 * the code here is just wiring.
 */
import * as path from "node:path";
import { Component, type Project } from "projen";
import { project as projectApi } from "@dbx-tools/projen";

const SCOPE = "dbx-tools";

/**
 * Gitignore every projen-GENERATED (read-only) file across the demo tree -
 * including the root/package manifests - so the committed demo carries only
 * hand-authored source. This shows the full `dbxtools sync` story: copy the
 * folder, run `dbxtools sync`, and EVERYTHING generated (package.json,
 * pnpm-workspace.yaml, tsconfigs, `.projen/*`, vite config, barrels, ...) is
 * regenerated from `.projenrc.ts` locally rather than shipped. `dbxtools sync`
 * bootstraps even an otherwise-empty folder (pnpm init + seed the workspace),
 * so nothing generated needs to be committed.
 *
 * Runs at preSynthesize (after every file/subproject exists) and walks the whole
 * subtree, adding each read-only file's project-relative path to that project's
 * own `.gitignore`.
 */
class IgnoreGeneratedFiles extends Component {
  public override preSynthesize(): void {
    const root = this.project.root;
    // Write every ignore to the ROOT `.gitignore` (with paths relative to the
    // root) rather than each child's own file. git applies the root's ignores
    // tree-wide, and this sidesteps the engine's child-`.gitignore` drop logic
    // (an empty child gitignore is removed at presynth, which raced with adding
    // to it here and left some child files un-ignored).
    root.gitignore.removePatterns("!/package.json");
    for (const p of allProjects(root)) {
      const prefix = relativePosix(root.outdir, p.outdir);
      // `package.json` is projen-generated but kept WRITABLE (readonly === false)
      // on a project root, so the readonly walk below misses it. Ignore it
      // explicitly - `dbxtools sync` regenerates it (bootstrapping even an empty
      // folder), so nothing generated needs to be committed.
      root.gitignore.addPatterns(joinPosix(prefix, "package.json"));
      for (const file of p.files) {
        if (file.readonly) root.gitignore.addPatterns(joinPosix(prefix, file.path));
      }
    }
  }
}

/** The project and every subproject beneath it, depth-first. */
function* allProjects(project: Project): Generator<Project> {
  yield project;
  for (const sub of project.subprojects) yield* allProjects(sub);
}

/** Root-anchored (`/a/b`) gitignore path for a project file, POSIX-separated. */
function joinPosix(prefix: string, file: string): string {
  const rel = prefix ? `${prefix}/${file}` : file;
  return `/${rel.replace(/\\/g, "/")}`;
}

/** `to` relative to `from`, POSIX-separated (empty when equal). */
function relativePosix(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, "/");
}

const project = new projectApi.DBXToolsNodeProject({
  name: `@${SCOPE}/demo`,
  scope: SCOPE,
  // Discover packages from the demo root; the leading path segment is the tier
  // and derives the tag (`server/appkit-demo` -> `server`, `app/appkit-demo` ->
  // `app`), exactly like the main repo's `workspaces/<tier>/<pkg>` layout.
  workspacePackageRoots: ["."],
  // A consumer, not a publisher: no GitHub/release wiring.
  github: false,
  release: false,
  depsUpgrade: false,
  // Track the latest published engine (any version) rather than a pinned
  // `^0.0.0`. `engineSelfDependency` reuses whatever specifier the consumer
  // already declares for `@dbx-tools/projen`, so declaring `*` here keeps the
  // demo on the newest engine on the registry - matching how the feature deps
  // below use `@*`.
  devDeps: ["@dbx-tools/projen@*"],
});

// Runtime deps the Mastra agent framework + email add-on pull in. The
// `@dbx-tools/*` packages declare these as peers, so the app pins them.
project.pnpmWorkspace?.addCatalog("@mastra/core", "^1.47.0");
project.pnpmWorkspace?.addCatalog("@mastra/ai-sdk", "^1.6.0");
project.pnpmWorkspace?.addCatalog("@mastra/express", "^1.4.2");
project.pnpmWorkspace?.addCatalog("@mastra/fastembed", "^1.2.0");
project.pnpmWorkspace?.addCatalog("@mastra/mcp", "^1.12.0");
project.pnpmWorkspace?.addCatalog("@mastra/memory", "^1.21.2");
project.pnpmWorkspace?.addCatalog("@mastra/observability", "^1.15.2");
project.pnpmWorkspace?.addCatalog("@mastra/otel-bridge", "^1.4.0");
project.pnpmWorkspace?.addCatalog("@mastra/pg", "^1.14.2");
project.pnpmWorkspace?.addCatalog("@opentelemetry/api", "^1.9.1");
project.pnpmWorkspace?.addCatalog("marked", "^18.0.5");
// React `ui` stack (Tailwind v4 + the chat UI deps).
project.pnpmWorkspace?.addCatalog("@tailwindcss/vite", "^4.3.1");
project.pnpmWorkspace?.addCatalog("tailwindcss", "^4.3.2");
project.pnpmWorkspace?.addCatalog("tw-animate-css", "^1.4.0");
project.pnpmWorkspace?.addCatalog("react-router-dom", "^7.6.2");

// The `@dbx-tools/*` packages resolve from the registry configured in `.npmrc`.
// `*` (any published version) keeps the demo decoupled from a specific release;
// pin a real range once the packages are on public npm.
const dep = (name: string) => `${name}@*`;

// server/appkit-demo: the AppKit server. `server` tag supplies express + tsx
// dev/start; add the feature packages it mounts and their peer runtime deps.
projectApi.applyToProjects(project, { identifierName: "server-appkit-demo", tags: "server" }, (p) => {
  p.package.addField("name", "@dbx-tools/demo-appkit-server");
  // A private runnable app, not an importable library: the entry is
  // `src/server.ts` (run by the `server` tag's dev/start tasks), so drop the
  // default root `index.ts` main/exports surface.
  p.package.addField("main", "src/server.ts");
  p.package.addField("exports", { "./package.json": "./package.json" });
  p.addDeps(
    dep("@dbx-tools/appkit"),
    dep("@dbx-tools/appkit-mastra"),
    dep("@dbx-tools/email"),
    "@databricks/appkit@catalog:",
    "@databricks/sdk-experimental@catalog:",
    "@mastra/core@catalog:",
    "@mastra/ai-sdk@catalog:",
    "@mastra/express@catalog:",
    "@mastra/fastembed@catalog:",
    "@mastra/mcp@catalog:",
    "@mastra/memory@catalog:",
    "@mastra/observability@catalog:",
    "@mastra/otel-bridge@catalog:",
    "@mastra/pg@catalog:",
    "@opentelemetry/api@catalog:",
    "marked@catalog:",
    "zod@catalog:",
    "pg@^8.22.0",
    "nodemailer@^7.0.13",
    "juice@^12.1.1",
    "fuse.js@^7.4.2",
  );
  // The `@dbx-tools/*` packages ship TypeScript source (consumed via their
  // `source`/`.ts` entry), so type-checking the server also checks their
  // imported source - which needs these ambient `@types` present here.
  p.addDevDeps(
    "@types/nodemailer@^7",
    "@types/pg@^8",
    "@types/json-schema@^7",
  );
});

// app/appkit-demo: the React client. `app` tag supplies react + vite +
// `vite.config.ts`; add the UI packages and Tailwind (loaded via the
// `vite.config.override.js`).
projectApi.applyToProjects(project, { identifierName: "app-appkit-demo", tags: "app" }, (p) => {
  p.package.addField("name", "@dbx-tools/demo-appkit-app");
  p.addDeps(
    dep("@dbx-tools/ui-appkit"),
    dep("@dbx-tools/ui-mastra"),
    "react-router-dom@catalog:",
  );
  p.addDevDeps("@tailwindcss/vite@catalog:", "tailwindcss@catalog:");
  // `@databricks/appkit-ui`'s stylesheet `@import`s `tw-animate-css`, so the
  // app (which owns the Tailwind build) must provide it.
  p.addDeps("tw-animate-css@catalog:");
});

// Gitignore all generated files so the committed demo is hand-authored source
// only - a copied folder regenerates them via `dbxtools sync` / `pnpm install`.
new IgnoreGeneratedFiles(project);

project.synth();
