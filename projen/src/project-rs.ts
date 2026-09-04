/** Filesystem-discovered Rust workspaces and UniFFI binding package wiring. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { string } from "@dbx-tools/shared-core";
import { Project, TextFile, javascript } from "projen";
import type { DBXToolsProject } from "./project.ts";
import { DBXToolsTypeScriptProject } from "./project-js.ts";
import type { PythonPackageOptions } from "./project-py.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";

export interface CargoDependencyOptions {
  readonly version?: string;
  readonly workspace?: boolean;
  readonly path?: string;
  readonly optional?: boolean;
  readonly defaultFeatures?: boolean;
  readonly features?: readonly string[];
}

export type CargoDependency = string | CargoDependencyOptions;

export interface RustPackageOptions {
  readonly directory: string;
  readonly description?: string;
  readonly dependencies?: Readonly<Record<string, CargoDependency>>;
  readonly devDependencies?: Readonly<Record<string, CargoDependency>>;
  readonly features?: Readonly<Record<string, readonly string[]>>;
  readonly defaultFeatures?: readonly string[];
  readonly binaryName?: string;
  readonly bindings?: readonly ("node" | "python")[];
  readonly nodeDependencies?: readonly string[];
  readonly nodeDevDependencies?: readonly string[];
  readonly uniffiConfig?: Readonly<Record<string, unknown>>;
}

export interface DBXToolsRustWorkspaceOptions {
  readonly root?: string;
  readonly scope: string;
  readonly edition?: string;
  readonly rustVersion?: string;
  readonly license?: string;
  readonly repository?: string;
  readonly workspaceDependencies?: Readonly<Record<string, CargoDependency>>;
  readonly packages?: Readonly<Record<string, Omit<RustPackageOptions, "directory">>>;
  readonly nodeRoot?: string;
  readonly pythonRoot?: string;
  readonly pythonModulePrefix?: string;
}

/** Persisted mapping consumed by the focused Rust source watcher. */
export interface RustBindingMapping {
  readonly crate: string;
  readonly rust: string;
  readonly node?: string;
  readonly python?: string;
}

/** Persisted Rust workspace state consumed by `sync --watch`. */
export interface RustWorkspaceMapping {
  readonly root: string;
  readonly crates: readonly string[];
  readonly bindings: readonly RustBindingMapping[];
}

function rustSources(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...rustSources(path));
    else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(path);
  }
  return files;
}

/** Whether a Rust crate embeds the UniFFI proc-macro scaffolding marker. */
export function hasUniFFIBindings(directory: string): boolean {
  return rustSources(join(directory, "src")).some((path) =>
    /\buniffi\s*::\s*setup_scaffolding\s*!\s*\(/.test(readFileSync(path, "utf8")),
  );
}

export function discoverRustCrates(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => rustSources(join(root, entry.name, "src")).length > 0)
    .map((entry) => entry.name)
    .sort();
}

function cargoDependency(value: CargoDependency): string | Record<string, unknown> {
  if (typeof value === "string") return value;
  return {
    ...(value.version ? { version: value.version } : {}),
    ...(value.workspace ? { workspace: true } : {}),
    ...(value.path ? { path: value.path } : {}),
    ...(value.optional ? { optional: true } : {}),
    ...(value.defaultFeatures === false ? { "default-features": false } : {}),
    ...(value.features?.length ? { features: [...value.features] } : {}),
  };
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${key} = ${tomlValue(entry)}`)
      .join(", ")} }`;
  }
  throw new Error(`Unsupported Cargo TOML value: ${String(value)}`);
}

function renderToml(value: Record<string, unknown>): string {
  const blocks: string[] = [];
  for (const [section, entries] of Object.entries(value)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    const rows = Object.entries(entries).map(([key, entry]) => `${key} = ${tomlValue(entry)}`);
    blocks.push(`${section === "bin" ? "[[bin]]" : `[${section}]`}\n${rows.join("\n")}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** One generated Cargo workspace member. */
export class DBXToolsRustProject extends Project implements DBXToolsProject {
  readonly language = "rust" as const;
  readonly crateName: string;
  readonly packageOptions: RustPackageOptions;
  readonly uniffi: boolean;

  constructor(
    parent: javascript.NodeProject,
    root: string,
    scope: string,
    options: RustPackageOptions,
  ) {
    const crateName = `${string.toSlug(scope)}-${options.directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
    super({ parent, outdir: `${root}/${options.directory}`, name: crateName });
    this.crateName = crateName;
    this.packageOptions = options;
    this.uniffi = hasUniFFIBindings(this.outdir);
    const library = existsSync(join(this.outdir, "src/lib.rs"));
    const manifest: Record<string, unknown> = {
      package: {
        name: crateName,
        version: { workspace: true },
        edition: { workspace: true },
        "rust-version": { workspace: true },
        description: options.description ?? crateName,
        license: { workspace: true },
        repository: { workspace: true },
      },
      ...(library
        ? {
            lib: {
              name: crateName.replaceAll("-", "_"),
              path: "src/lib.rs",
              ...(this.uniffi ? { "crate-type": ["lib", "cdylib"] } : {}),
            },
          }
        : {}),
      ...(this.uniffi || options.binaryName
        ? {
            bin: this.uniffi
              ? { name: "uniffi-bindgen", path: "uniffi-bindgen.rs" }
              : { name: options.binaryName, path: "src/main.rs" },
          }
        : {}),
      ...(options.features || options.defaultFeatures
        ? {
            features: {
              ...(options.defaultFeatures ? { default: [...options.defaultFeatures] } : {}),
              ...options.features,
            },
          }
        : {}),
      ...(options.dependencies
        ? {
            dependencies: Object.fromEntries(
              Object.entries(options.dependencies).map(([name, value]) => [
                name,
                cargoDependency(value),
              ]),
            ),
          }
        : {}),
      ...(options.devDependencies
        ? {
            "dev-dependencies": Object.fromEntries(
              Object.entries(options.devDependencies).map(([name, value]) => [
                name,
                cargoDependency(value),
              ]),
            ),
          }
        : {}),
    };
    new TextFile(this, "Cargo.toml", { lines: renderToml(manifest).trimEnd().split("\n") });
    if (this.uniffi) {
      new TextFile(this, "uniffi-bindgen.rs", {
        lines: ["fn main() {", "    uniffi::uniffi_bindgen_main();", "}", ""],
      });
      new TextFile(this, "uniffi.toml", {
        lines: renderToml(
          options.uniffiConfig ?? {
            "bindings.python": { cdylib_name: crateName.replaceAll("-", "_") },
            "bindings.typescript": { strictTypeChecking: true },
          },
        )
          .trimEnd()
          .split("\n"),
      });
    }
  }
}

/** Generated Rust workspace plus convention-derived private UniFFI packages. */
export class DBXToolsRustWorkspace {
  readonly packages: readonly DBXToolsRustProject[];
  readonly nodePackages: readonly DBXToolsTypeScriptProject[];
  readonly pythonPackages: readonly PythonPackageOptions[];
  readonly bindingMappings: readonly RustBindingMapping[];
  readonly workspaceMapping: RustWorkspaceMapping;

  constructor(project: javascript.NodeProject, options: DBXToolsRustWorkspaceOptions) {
    const root = options.root ?? "packages/rs";
    const nodeRoot = options.nodeRoot ?? "packages/js/node";
    const packageOptions = options.packages ?? {};
    this.packages = discoverRustCrates(resolve(project.outdir, root)).map(
      (directory) =>
        new DBXToolsRustProject(project, root, options.scope, {
          directory,
          ...packageOptions[directory],
        }),
    );

    const bindings = this.packages.filter((pkg) => pkg.uniffi);
    this.bindingMappings = bindings.map((pkg) => {
      const targets = pkg.packageOptions.bindings ?? ["node", "python"];
      return {
        crate: pkg.crateName,
        rust: `${root}/${pkg.packageOptions.directory}`,
        ...(targets.includes("node")
          ? { node: `${nodeRoot}/${pkg.packageOptions.directory}` }
          : {}),
        ...(targets.includes("python")
          ? { python: `${options.pythonRoot ?? "packages/py"}/${pkg.packageOptions.directory}` }
          : {}),
      };
    });
    this.workspaceMapping = {
      root,
      crates: this.packages.map((pkg) => `${root}/${pkg.packageOptions.directory}`),
      bindings: this.bindingMappings,
    };
    project.dbxToolsConfig.rust = this.workspaceMapping;
    this.pythonPackages = bindings
      .filter((pkg) => (pkg.packageOptions.bindings ?? ["node", "python"]).includes("python"))
      .map((pkg) => ({
        directory: `${options.pythonRoot ?? "packages/py"}/${pkg.packageOptions.directory}`.replace(
          /^packages\/py\//,
          "",
        ),
        name: pkg.crateName,
        module: `${options.pythonModulePrefix ?? options.scope.replaceAll("-", "_")}.${pkg.packageOptions.directory.replaceAll("-", "_")}`,
        description: `Python bindings for ${pkg.crateName}`,
        private: true,
      }));

    const existing = new Map(
      project.subprojects.map((child) => [relative(project.outdir, child.outdir), child]),
    );
    const nodePackages: DBXToolsTypeScriptProject[] = [];
    for (const binding of bindings.filter((pkg) =>
      (pkg.packageOptions.bindings ?? ["node", "python"]).includes("node"),
    )) {
      const directory = binding.packageOptions.directory;
      const memberPath = `${nodeRoot}/${directory}`;
      const found = existing.get(memberPath);
      const node =
        found instanceof DBXToolsTypeScriptProject
          ? found
          : new DBXToolsTypeScriptProject({
              parent: project,
              outdir: memberPath,
              name: `@${string.toSlug(options.scope)}/${directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
              tags: ["node"],
            });
      node.package.addField(
        "name",
        `@${string.toSlug(options.scope)}/${directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
      );
      node.package.addField("private", true);
      node.package.file.addDeletionOverride("publishConfig");
      node.package.addField("description", `Node bindings for ${binding.crateName}`);
      node.addDeps("@ubjs/core@0.31.0-5", "@ubjs/node@0.31.0-5");
      if (binding.packageOptions.nodeDependencies?.length) {
        node.addDeps(...binding.packageOptions.nodeDependencies);
      }
      node.addDevDeps("uniffi-bindgen-react-native@0.31.0-5");
      if (binding.packageOptions.nodeDevDependencies?.length) {
        node.addDevDeps(...binding.packageOptions.nodeDevDependencies);
      }
      node.compileTask.reset();
      new TextFile(node, "exports.ts", {
        lines: ['export * from "./src/bindings.ts";', ""],
      });
      nodePackages.push(node);
    }
    this.nodePackages = nodePackages;

    const generatedWorkspaceManifest: Record<string, unknown> = {
      workspace: {
        members: this.packages.map((pkg) => `${root}/${pkg.packageOptions.directory}`),
        "default-members": this.packages
          .filter((pkg) => !pkg.uniffi)
          .map((pkg) => `${root}/${pkg.packageOptions.directory}`),
        resolver: "2",
      },
      "workspace.package": {
        version: readWorkspaceVersion(project.outdir),
        edition: options.edition ?? "2021",
        "rust-version": options.rustVersion ?? "1.82",
        license: options.license ?? "Apache-2.0",
        repository: options.repository ?? "",
      },
      ...(options.workspaceDependencies
        ? {
            "workspace.dependencies": Object.fromEntries(
              Object.entries(options.workspaceDependencies).map(([name, value]) => [
                name,
                cargoDependency(value),
              ]),
            ),
          }
        : {}),
    };
    new TextFile(project, "Cargo.toml", {
      lines: renderToml(generatedWorkspaceManifest).trimEnd().split("\n"),
    });
    project.addTask("rs:format", { exec: "cargo fmt --all" });
    project.addTask("rs:lint", { exec: "cargo clippy --workspace --all-targets --all-features" });
    project.addTask("rs:test", { exec: "cargo test --workspace" });
    project.addTask("rs:build", { exec: "cargo build --workspace" });
    project.addTask("rs:bindings", {
      exec: "bun node_modules/@dbx-tools/projen/tasks/rust.ts",
      description: "Generate language bindings for UniFFI-enabled Rust crates",
    });
    project.addTask("rs:bindings:demo", {
      description: "Generate and run UniFFI Node and Python example CLIs",
      exec: [
        "bun run rs:bindings",
        ...this.bindingMappings.flatMap((binding) => [
          ...(binding.node ? [`bun ${binding.node}/test/cli.ts`] : []),
          ...(binding.python
            ? [`uv run --project ${binding.python} ${binding.python}/test/cli.py`]
            : []),
        ]),
      ].join(" && "),
    });
  }
}
