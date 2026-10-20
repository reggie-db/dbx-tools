/**
 * One Bun-first AppKit application rooted at a conventional workspace folder.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Component, JsonFile, type Task, TextFile, javascript, typescript } from "projen";
import { BunBuildFile, BunfigFile } from "./bun-app.ts";
import { BUN_VERSION } from "./bun-workflow.ts";
import { headerLines } from "./generated.ts";

/** AppKit workspace discovery and validation mode. */
export type AppKitWorkspaceMode = "auto" | boolean;

/** Minimal generated Databricks bundle settings. */
export interface AppKitBundleOptions {
  readonly description?: string;
  readonly name?: string;
}

/** Application project and generated bundle behavior. */
export interface AppKitWorkspaceOptions {
  readonly application: javascript.NodeProject;
  readonly bundle?: false | AppKitBundleOptions;
  readonly validate?: boolean;
}

const REQUIRED_APPLICATION_FILES = ["client/index.html", "server/server.ts"] as const;

/** Whether the application root contains the entries required by AppKit. */
export function isAppKitApplication(project: javascript.NodeProject): boolean {
  return REQUIRED_APPLICATION_FILES.every((path) => existsSync(join(project.outdir, path)));
}

/** Own the generated configuration and root tasks for one AppKit application. */
export class AppKitWorkspace extends Component {
  private readonly applicationDirectory: string;
  private readonly deployTask: Task;

  constructor(project: javascript.NodeProject, options: AppKitWorkspaceOptions) {
    super(project);
    this.applicationDirectory = relative(project.outdir, options.application.outdir)
      .split(sep)
      .join("/");

    if (options.validate) validateApplication(options.application);
    configureApplication(options.application, options.bundle);

    project.gitignore.addPatterns(`${this.applicationDirectory}/.databricks`);
    const sync = project.addTask("appkit:sync", {
      description: "Synchronize installed AppKit plugin metadata",
      exec: "appkit plugin sync --write --silent",
    });
    sync.cwd = this.applicationDirectory;
    const typegen = project.addTask("appkit:typegen", {
      description: "Generate AppKit client declarations",
      exec: "appkit generate-types",
    });
    typegen.cwd = this.applicationDirectory;
    this.deployTask = project.addTask("appkit:deploy", {
      description: "Deploy the AppKit application from an npm-compatible source snapshot",
      execArgs: [
        "bun",
        "node_modules/@dbx-tools/projen/tasks/appkit-deploy.ts",
        "--directory",
        this.applicationDirectory,
      ],
      receiveArgs: true,
    });
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
        description: "Validate with Bun and deploy the AppKit application",
      });
      deploy.spawn(check);
      deploy.spawn(this.deployTask);
    }
    if (!this.project.tasks.tryFind("dev")) {
      const dev = this.project.addTask("dev", {
        description: "Run the AppKit server in development mode",
        env: { NODE_ENV: "development" },
        exec: "bun --watch server/server.ts",
        receiveArgs: true,
      });
      dev.cwd = this.applicationDirectory;
    }
    if (!this.project.tasks.tryFind("start")) {
      const start = this.project.addTask("start", {
        description: "Run the AppKit server in production mode",
        env: { NODE_ENV: "production" },
        exec: "bun server/server.ts",
        receiveArgs: true,
      });
      start.cwd = this.applicationDirectory;
    }
  }
}

function validateApplication(project: javascript.NodeProject): void {
  const missing = REQUIRED_APPLICATION_FILES.filter(
    (path) => !existsSync(join(project.outdir, path)),
  );
  if (missing.length > 0) {
    throw new Error(
      `appkit: true requires ${missing.map((path) => `${project.name}/${path}`).join(", ")}`,
    );
  }
}

function configureApplication(
  project: javascript.NodeProject,
  bundle: false | AppKitBundleOptions | undefined,
): void {
  project.package.addField("private", true);
  project.package.addField("appkit", { autoMigrate: false });
  project.package.addField("main", "server/server.ts");
  project.package.addField("types", "server/server.ts");
  project.package.addField("exports", { "./package.json": "./package.json" });
  project.setScript("build", "bun build.ts");
  project.addDeps(
    `bun@${BUN_VERSION}`,
    "@databricks/appkit@catalog:",
    "@databricks/appkit-ui@catalog:",
    "@databricks/sdk-experimental@catalog:",
    "@tailwindcss/vite@catalog:",
    "@vitejs/plugin-react@catalog:",
    "react@catalog:",
    "react-dom@catalog:",
    "tailwindcss@catalog:",
  );
  project.addDevDeps(
    `@types/bun@${BUN_VERSION}`,
    "@types/node@catalog:",
    "@types/react@catalog:",
    "@types/react-dom@catalog:",
    "bun-plugin-tailwind@catalog:",
    "vite@catalog:",
  );
  project.gitignore.addPatterns("/client/dist", "/server/lib");
  project.tryRemoveFile("test/tsconfig.json");
  project.testTask.reset("bun test server/test --pass-with-no-tests");
  project.addTask("dev", {
    description: "Run the AppKit server in development mode",
    env: { NODE_ENV: "development" },
    exec: "bun --watch server/server.ts",
    receiveArgs: true,
  });
  project.addTask("start", {
    description: "Run the AppKit server in production mode",
    env: { NODE_ENV: "production" },
    exec: "bun server/server.ts",
    receiveArgs: true,
  });
  project.addTask("appkit:sync", {
    description: "Synchronize installed AppKit plugin metadata",
    exec: "appkit plugin sync --write --silent",
  });
  project.addTask("appkit:typegen", {
    description: "Generate AppKit client declarations",
    exec: "appkit generate-types",
  });

  configureTypeScript(project);
  new BunfigFile(project);
  new BunBuildFile(project, {
    entrypoint: "client/index.html",
    outdir: "client/dist",
    publicDir: "client/public",
    sourceRoot: "client/src",
    tsconfig: "tsconfig.client.json",
  });
  new AppKitViteConfig(project);
  new AppYaml(project);
  if (bundle !== false) new DatabricksBundleFile(project, bundle);

  project.compileTask.reset("tsc -p tsconfig.server.json --noEmit");
  project.compileTask.exec("tsc -p tsconfig.client.json --noEmit");
  project.compileTask.exec("bun build.ts");
}

function configureTypeScript(project: javascript.NodeProject): void {
  new JsonFile(project, "tsconfig.shared.json", {
    marker: true,
    readonly: true,
    obj: {
      compilerOptions: {
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        noImplicitReturns: true,
        module: "ESNext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        esModuleInterop: true,
        jsx: "react-jsx",
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
    },
  });
  new JsonFile(project, "tsconfig.client.json", {
    marker: true,
    readonly: true,
    obj: {
      extends: "./tsconfig.shared.json",
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["vite/client", "node"],
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        moduleDetection: "force",
        noEmit: true,
        jsx: "react-jsx",
        noUncheckedSideEffectImports: true,
        baseUrl: "./client",
        paths: { "@/*": ["./src/*"] },
      },
      include: ["client/src", "client/vite.config.override.ts", "shared/appkit-types"],
    },
  });
  new JsonFile(project, "tsconfig.server.json", {
    marker: true,
    readonly: true,
    obj: {
      extends: "./tsconfig.shared.json",
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        types: ["node"],
        allowImportingTsExtensions: true,
        noEmit: true,
        rootDir: ".",
      },
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: ["node_modules", "client"],
    },
  });

  if (!(project instanceof typescript.TypeScriptProject) || !project.tsconfig) return;
  project.tsconfig.file.addDeletionOverride("compilerOptions");
  project.tsconfig.file.addDeletionOverride("include");
  project.tsconfig.file.addOverride("files", []);
  project.tsconfig.file.addOverride("references", [
    { path: "./tsconfig.client.json" },
    { path: "./tsconfig.server.json" },
  ]);
}

class AppKitViteConfig extends TextFile {
  constructor(project: javascript.NodeProject) {
    super(project, "client/vite.config.ts", {
      marker: true,
      readonly: true,
      lines: [
        ...headerLines({ tool: "projen", source: ".projenrc.ts" }),
        'import { existsSync } from "node:fs";',
        'import path from "node:path";',
        'import { appKitServingTypesPlugin, appKitTypesPlugin } from "@databricks/appkit";',
        'import react from "@vitejs/plugin-react";',
        'import tailwindcss from "@tailwindcss/vite";',
        'import { defineConfig, mergeConfig, type UserConfig } from "vite";',
        "",
        'const overrideUrl = new URL("./vite.config.override.ts", import.meta.url);',
        "const override = existsSync(overrideUrl)",
        "  ? ((await import(overrideUrl.href)).default as UserConfig)",
        "  : {};",
        "",
        "export default defineConfig(",
        "  mergeConfig(",
        "    {",
        "      root: import.meta.dirname,",
        "      plugins: [",
        "        react(),",
        "        tailwindcss(),",
        '        appKitTypesPlugin({ outFile: "shared/appkit-types/analytics.d.ts" }),',
        '        appKitServingTypesPlugin({ outFile: "shared/appkit-types/serving.d.ts" }),',
        "      ],",
        "      server: { middlewareMode: true },",
        "      build: {",
        '        outDir: path.resolve(import.meta.dirname, "dist"),',
        "        emptyOutDir: true,",
        '        sourcemap: process.env.NODE_ENV === "development",',
        "      },",
        '      optimizeDeps: { include: ["react", "react-dom", "react/jsx-dev-runtime", "react/jsx-runtime"] },',
        '      resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },',
        "    },",
        "    override,",
        "  ),",
        ");",
      ],
    });
  }
}

class AppYaml extends TextFile {
  constructor(project: javascript.NodeProject) {
    super(project, "app.yaml", {
      marker: false,
      readonly: true,
      lines: [
        ...headerLines({ tool: "projen", source: ".projenrc.ts", comment: "#" }),
        "command:",
        "  - ./node_modules/.bin/bun",
        "  - server/server.ts",
        "",
      ],
    });
  }
}

class DatabricksBundleFile extends TextFile {
  constructor(project: javascript.NodeProject, options: AppKitBundleOptions = {}) {
    const name = options.name ?? project.name.replace(/^@[^/]+\//, "");
    const description = options.description ?? "A Databricks App powered by AppKit";
    super(project, "databricks.yml", {
      marker: false,
      readonly: true,
      lines: [
        ...headerLines({ tool: "projen", source: ".projenrc.ts", comment: "#" }),
        "bundle:",
        `  name: ${JSON.stringify(name)}`,
        "  engine: direct",
        "",
        "resources:",
        "  apps:",
        "    app:",
        `      name: ${JSON.stringify(name)}`,
        `      description: ${JSON.stringify(description)}`,
        "      source_code_path: ./",
        "      lifecycle:",
        "        started: true",
        "",
        "targets:",
        "  dev:",
        "    default: true",
        "    mode: development",
        "",
      ],
    });
  }
}
