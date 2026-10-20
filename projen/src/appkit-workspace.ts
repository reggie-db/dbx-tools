/**
 * AppKit workspace conventions for paired browser and server packages.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { Component, type Task, TextFile, javascript, typescript } from "projen";
import { headerLines } from "./generated.ts";

/** AppKit workspace discovery and validation mode. */
export type AppKitWorkspaceMode = "auto" | boolean;

/** Projects configured by the AppKit workspace owner. */
export interface AppKitWorkspaceOptions {
  /** Browser application packages carrying the `app` tag. */
  readonly apps: readonly javascript.NodeProject[];
  /** AppKit backend packages carrying the `server` tag. */
  readonly servers: readonly javascript.NodeProject[];
  /** Fail synthesis when an AppKit package or required entry file is missing. */
  readonly validate?: boolean;
}

/**
 * Own the dependencies and generated configuration shared by AppKit workspaces.
 */
export class AppKitWorkspace extends Component {
  private readonly deployTask: Task;
  private readonly serverEntrypoint?: string;

  constructor(project: javascript.NodeProject, options: AppKitWorkspaceOptions) {
    super(project);

    if (options.validate) validateWorkspace(options);
    project.gitignore.addPatterns(".databricks");
    project.addTask("appkit:sync", {
      description: "Synchronize installed AppKit plugin metadata",
      exec: "appkit plugin sync --write --silent",
    });
    this.deployTask = project.addTask("appkit:deploy", {
      description: "Deploy the AppKit workspace from an npm-compatible source snapshot",
      execArgs: ["bun", "node_modules/@dbx-tools/projen/tasks/appkit-deploy.ts"],
      receiveArgs: true,
    });

    for (const app of options.apps) configureApp(app);
    for (const server of options.servers) configureServer(server);
    if (options.servers.length === 1) {
      const server = options.servers[0]!;
      const entrypoint = serverEntrypoint(server);
      this.serverEntrypoint = relative(project.outdir, join(server.outdir, entrypoint))
        .split(sep)
        .join("/");
    }
  }

  public override preSynthesize(): void {
    let check = this.project.tasks.tryFind("check");
    if (!check) {
      check = this.project.addTask("check", {
        description: "Validate the generated workspace with Bun",
      });
      check.spawn(this.project.buildTask);
    }
    if (!this.project.tasks.tryFind("deploy")) {
      const deploy = this.project.addTask("deploy", {
        description: "Validate with Bun and deploy the AppKit workspace",
      });
      deploy.spawn(check);
      deploy.spawn(this.deployTask);
    }
    if (!this.serverEntrypoint) return;
    if (!this.project.tasks.tryFind("dev")) {
      this.project.addTask("dev", {
        description: "Run the AppKit server in development mode",
        env: { NODE_ENV: "development" },
        exec: `bun --watch ${this.serverEntrypoint}`,
        receiveArgs: true,
      });
    }
    if (!this.project.tasks.tryFind("start")) {
      this.project.addTask("start", {
        description: "Run the AppKit server in production mode",
        env: { NODE_ENV: "production" },
        exec: `bun ${this.serverEntrypoint}`,
        receiveArgs: true,
      });
    }
  }
}

/** Validate the explicit AppKit convention before generating dependent config. */
function validateWorkspace(options: AppKitWorkspaceOptions): void {
  const missing: string[] = [];
  if (options.apps.length === 0) missing.push("an `app` package");
  if (options.servers.length === 0) missing.push("a `server` package");
  for (const app of options.apps) {
    if (!existsSync(join(app.outdir, "index.html"))) missing.push(`${app.name}/index.html`);
  }
  for (const server of options.servers) {
    const entrypoint = serverEntrypoint(server);
    if (!existsSync(join(server.outdir, entrypoint))) {
      missing.push(`${server.name}/${entrypoint}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`appkit: true requires ${missing.join(", ")}`);
  }
}

/** Configure one AppKit browser application without broadening React libraries. */
function configureApp(project: javascript.NodeProject): void {
  project.package.addField("appkit", { autoMigrate: false });
  project.addDeps(
    "@databricks/appkit-ui@catalog:",
    "@tailwindcss/vite@catalog:",
    "tailwindcss@catalog:",
  );
  project.addDevDeps("@databricks/appkit@catalog:", "vite@catalog:");
  const typesDirectory = `${basename(project.outdir)}/shared/appkit-types`;
  new TextFile(project, "vite.config.ts", {
    marker: true,
    readonly: true,
    lines: [
      ...headerLines({ tool: "projen", source: ".projenrc.ts" }),
      'import { existsSync } from "node:fs";',
      'import { appKitServingTypesPlugin, appKitTypesPlugin } from "@databricks/appkit";',
      'import tailwindcss from "@tailwindcss/vite";',
      'import { defineConfig, mergeConfig, type UserConfig } from "vite";',
      "",
      `const appKitTypesDirectory = ${JSON.stringify(typesDirectory)};`,
      'const overrideUrl = new URL("./vite.config.override.ts", import.meta.url);',
      "const override = existsSync(overrideUrl)",
      "  ? ((await import(overrideUrl.href)).default as UserConfig)",
      "  : {};",
      "",
      "export default defineConfig(",
      "  mergeConfig(",
      "    {",
      "      plugins: [",
      "        tailwindcss(),",
      "        appKitTypesPlugin({",
      "          outFile: `${appKitTypesDirectory}/analytics.d.ts`,",
      "        }),",
      "        appKitServingTypesPlugin({",
      "          outFile: `${appKitTypesDirectory}/serving.d.ts`,",
      "        }),",
      "      ],",
      "    },",
      "    override,",
      "  ),",
      ");",
    ],
  });

  if (!(project instanceof typescript.TypeScriptProject)) return;
  project.tsconfig?.file.addOverride("compilerOptions.rootDir", ".");
  project.tsconfig?.addInclude("vite.config.ts");
  project.tsconfig?.addInclude("vite.config.override.ts");
  project.tsconfig?.addInclude("shared/appkit-types");
}

/** Configure one AppKit server with the runtime dependency its Vite loader imports. */
function configureServer(project: javascript.NodeProject): void {
  const entrypoint = serverEntrypoint(project);
  if (entrypoint !== project.package.manifest.main) {
    project.package.addField("main", entrypoint);
    project.package.addField("types", entrypoint);
  }
  project.addDeps("@databricks/appkit@catalog:", "@vitejs/plugin-react@catalog:");
}

/** Prefer the canonical AppKit server entry when a package still has its default barrel. */
function serverEntrypoint(project: javascript.NodeProject): string {
  const configured =
    typeof project.package.manifest.main === "string" ? project.package.manifest.main : "index.ts";
  const canonical = "src/server.ts";
  return configured === "index.ts" && existsSync(join(project.outdir, canonical))
    ? canonical
    : configured;
}
