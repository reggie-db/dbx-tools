/** Projen-native standalone and workspace-owned Rust project implementation. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { projectUtils } from "@dbx-tools/core";
import { stringUtils } from "@dbx-tools/shared-core";
import { License, Project, TextFile, TomlFile, javascript, type Task } from "projen";
import { DBX_TOOLS_LICENSE, projectRepositoryUrl } from "./project-js.ts";
import type { RustReleaseOs } from "./project-rs.ts";
import type { DBXToolsProject, DBXToolsProjectOptions } from "./project.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";

export interface CargoDependencyOptions {
  readonly version?: string;
  readonly workspace?: boolean;
  readonly path?: string;
  readonly optional?: boolean;
  readonly package?: string;
  readonly defaultFeatures?: boolean;
  readonly features?: readonly string[];
}

export type CargoDependency = string | CargoDependencyOptions;

export interface RustCliOptions {
  /** `dbx` subcommand. Defaults to the Rust package directory. */
  readonly command?: string;
  /** Root CLI help text. Defaults to the Rust package description. */
  readonly description?: string;
}

/** Explicit Cargo example target and the feature gate required to compile it. */
export interface CargoExampleOptions {
  readonly name: string;
  /** Source path relative to the crate root. Defaults to Cargo's conventional path. */
  readonly path?: string;
  /** Features Cargo must enable before compiling this example. */
  readonly requiredFeatures?: readonly string[];
}

/** Cargo package, target, binding, and release behavior shared by every Rust project. */
export interface RustCrateOptions {
  readonly description?: string;
  /** Keep this crate unpublished and out of public docs. */
  readonly private?: boolean;
  /** Build this crate's binary for each target and attach it to the GitHub release. */
  readonly release?: boolean;
  /** Omit this crate and any release binary artifact from these operating systems. */
  readonly releaseExcludeOs?: readonly RustReleaseOs[];
  readonly dependencies?: Readonly<Record<string, CargoDependency>>;
  readonly devDependencies?: Readonly<Record<string, CargoDependency>>;
  readonly features?: Readonly<Record<string, readonly string[]>>;
  readonly defaultFeatures?: readonly string[];
  /** Explicit example targets, including optional Cargo feature gates. */
  readonly examples?: readonly CargoExampleOptions[];
  /** Cargo and release executable name. Defaults to the generated package name. */
  readonly binaryName?: string;
  /** Publish this release binary through the generated `dbx` command registry. */
  readonly cli?: boolean | RustCliOptions;
  readonly bindings?: readonly ("node" | "python")[];
  readonly uniffiConfig?: Readonly<Record<string, unknown>>;
}

/** Options for a standalone or workspace-owned Projen-native Cargo project. */
export interface DBXToolsRustProjectOptions extends DBXToolsProjectOptions, RustCrateOptions {
  /** Cargo package name. */
  readonly name: string;
  readonly parent?: Project;
  /** Package directory relative to its workspace root; inferred from `outdir` when omitted. */
  readonly directory?: string;
  /** Cargo workspace root used for generated workspace mappings. Defaults to `.`. */
  readonly workspaceRoot?: string;
  /** Inherit unspecified Cargo package metadata from `[workspace.package]`. */
  readonly workspace?: boolean;
  /** Crate-name scope retained for workspace package and binding naming. */
  readonly scope?: string;
  /** Concrete standalone package version. Defaults to `0.1.0`. */
  readonly version?: string;
  /** Rust edition. Defaults to `2021` for standalone projects. */
  readonly edition?: string;
  /** Minimum supported Rust version. Defaults to `1.82` for standalone projects. */
  readonly rustVersion?: string;
  /** SPDX license identifier. Defaults to Apache-2.0 for standalone projects. */
  readonly license?: string;
  /** Copyright owner written to a standalone license file. Defaults to the package name. */
  readonly copyrightOwner?: string;
  /** Source repository URL. Auto-detected for standalone projects when possible. */
  readonly repository?: string;
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

export function cargoDependency(
  value: CargoDependency,
  workspaceVersion?: string,
): string | Record<string, unknown> {
  if (typeof value === "string") return value;
  return {
    ...(value.version ? { version: value.version } : {}),
    ...(!value.version && value.path && workspaceVersion ? { version: workspaceVersion } : {}),
    ...(value.workspace ? { workspace: true } : {}),
    ...(value.path ? { path: value.path } : {}),
    ...(value.package ? { package: value.package } : {}),
    ...(value.optional ? { optional: true } : {}),
    ...(value.defaultFeatures === false ? { "default-features": false } : {}),
    ...(value.features?.length ? { features: [...value.features] } : {}),
  };
}

export function structuredTomlSections(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [section, contents] of Object.entries(value)) {
    const path = section.split(".");
    let target = result;
    for (const part of path.slice(0, -1)) {
      const current = target[part];
      if (current === undefined) {
        target[part] = {};
      } else if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error(`Conflicting TOML section ${section}`);
      }
      target = target[part] as Record<string, unknown>;
    }
    target[path.at(-1)!] = contents;
  }
  return result;
}

interface ResolvedRustProjectOptions extends DBXToolsRustProjectOptions {
  readonly directory: string;
  readonly outdir: string;
  readonly workspaceRoot: string;
}

function resolveRustProjectOptions(
  options: DBXToolsRustProjectOptions,
): ResolvedRustProjectOptions {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(options.name)) {
    throw new Error(`Invalid Cargo package name: ${options.name}`);
  }
  const directory =
    options.directory ??
    (options.outdir && options.outdir !== "."
      ? basename(options.outdir)
      : stringUtils.toSlug(options.name));
  return {
    ...options,
    directory,
    outdir: options.outdir ?? (options.parent ? directory : "."),
    workspaceRoot: options.workspaceRoot ?? ".",
  };
}

function packageOptions(
  options: ResolvedRustProjectOptions,
): RustCrateOptions & { readonly directory: string } {
  return {
    directory: options.directory,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.private !== undefined ? { private: options.private } : {}),
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.releaseExcludeOs ? { releaseExcludeOs: options.releaseExcludeOs } : {}),
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.devDependencies ? { devDependencies: options.devDependencies } : {}),
    ...(options.features ? { features: options.features } : {}),
    ...(options.defaultFeatures ? { defaultFeatures: options.defaultFeatures } : {}),
    ...(options.binaryName ? { binaryName: options.binaryName } : {}),
    ...(options.cli !== undefined ? { cli: options.cli } : {}),
    ...(options.bindings ? { bindings: options.bindings } : {}),
    ...(options.uniffiConfig ? { uniffiConfig: options.uniffiConfig } : {}),
  };
}

function inheritedCargoValue(
  workspace: boolean,
  configured: string | undefined,
  fallback: string,
): string | { workspace: true } {
  return workspace && configured === undefined ? { workspace: true } : (configured ?? fallback);
}

/** One standalone or workspace-owned Cargo project. */
export class RustProject extends Project implements DBXToolsProject {
  readonly language = "rust" as const;
  readonly crateName: string;
  readonly workspaceRoot: string;
  readonly scope: string;
  readonly packageOptions: RustCrateOptions & { readonly directory: string };
  readonly uniffi: boolean;
  readonly manifestFile: TomlFile;
  readonly lintTask: Task;
  readonly formatTask: Task;
  readonly formatCheckTask: Task;

  constructor(projectOptions: DBXToolsRustProjectOptions) {
    const options = resolveRustProjectOptions(projectOptions);
    super({ parent: options.parent, outdir: options.outdir, name: options.name });
    this.crateName = options.name;
    this.workspaceRoot = options.workspaceRoot;
    this.scope = stringUtils.toSlug(options.scope ?? options.name.split("-")[0]!);
    this.packageOptions = packageOptions(options);
    this.uniffi = hasUniFFIBindings(this.outdir);
    const library = existsSync(join(this.outdir, "src/lib.rs"));
    const binary = existsSync(join(this.outdir, "src/main.rs"));
    const binaryName = options.binaryName ?? this.crateName;
    const workspace = options.workspace === true;
    const projectDirectory = options.parent
      ? resolve(options.parent.outdir, options.outdir)
      : resolve(options.outdir);
    const repository =
      options.repository ??
      (options.parent instanceof javascript.NodeProject
        ? projectRepositoryUrl(options.parent)
        : projectUtils.repositoryUrl(projectDirectory));
    const dependencyVersion =
      options.version ?? (options.parent ? readWorkspaceVersion(options.parent.outdir) : "0.1.0");
    const manifest: Record<string, unknown> = {
      ...(!workspace ? { workspace: {} } : {}),
      package: {
        name: this.crateName,
        version: inheritedCargoValue(workspace, options.version, "0.1.0"),
        edition: inheritedCargoValue(workspace, options.edition, "2021"),
        "rust-version": inheritedCargoValue(workspace, options.rustVersion, "1.82"),
        description: options.description ?? this.crateName,
        license: inheritedCargoValue(workspace, options.license, DBX_TOOLS_LICENSE),
        ...(workspace && options.repository === undefined
          ? { repository: { workspace: true } }
          : repository
            ? { repository }
            : {}),
        ...(options.private ? { publish: false } : {}),
      },
      ...(library
        ? {
            lib: {
              name: this.crateName.replaceAll("-", "_"),
              path: "src/lib.rs",
              ...(this.uniffi ? { "crate-type": ["lib", "cdylib"] } : {}),
            },
          }
        : {}),
      ...(this.uniffi || binary
        ? {
            bin: [
              ...(this.uniffi
                ? [{ name: `${this.crateName}-uniffi-bindgen`, path: "uniffi-bindgen.rs" }]
                : []),
              ...(binary ? [{ name: binaryName, path: "src/main.rs" }] : []),
            ],
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
      ...(options.examples?.length
        ? {
            example: options.examples.map((example) => ({
              name: example.name,
              ...(example.path ? { path: example.path } : {}),
              ...(example.requiredFeatures?.length
                ? { "required-features": [...example.requiredFeatures] }
                : {}),
            })),
          }
        : {}),
      ...(options.dependencies
        ? {
            dependencies: Object.fromEntries(
              Object.entries(options.dependencies).map(([name, value]) => [
                name,
                cargoDependency(value, dependencyVersion),
              ]),
            ),
          }
        : {}),
      ...(options.devDependencies
        ? {
            "dev-dependencies": Object.fromEntries(
              Object.entries(options.devDependencies).map(([name, value]) => [
                name,
                cargoDependency(value, dependencyVersion),
              ]),
            ),
          }
        : {}),
    };
    this.manifestFile = new TomlFile(this, "Cargo.toml", { marker: false, obj: manifest });
    if (this.uniffi) {
      new TextFile(this, "uniffi-bindgen.rs", {
        lines: ["fn main() {", "    uniffi::uniffi_bindgen_main();", "}", ""],
      });
      new TomlFile(this, "uniffi.toml", {
        marker: false,
        obj: structuredTomlSections(
          options.uniffiConfig ?? {
            "bindings.python": { cdylib_name: this.crateName.replaceAll("-", "_") },
            "bindings.typescript": { strictTypeChecking: true },
          },
        ),
      });
    }
    this.compileTask.reset("cargo build");
    this.testTask.reset("cargo test");
    this.packageTask.reset("cargo package");
    this.lintTask = this.addTask("lint", {
      description: "Lint every Rust target and feature",
      exec: "cargo clippy --all-targets --all-features",
    });
    this.formatTask = this.addTask("format", {
      description: "Format Rust sources",
      exec: "cargo fmt",
    });
    this.formatCheckTask = this.addTask("format:check", {
      description: "Check Rust source formatting",
      exec: "cargo fmt -- --check",
    });
    if (!workspace) {
      new License(this, {
        spdx: options.license ?? DBX_TOOLS_LICENSE,
        copyrightOwner: options.copyrightOwner ?? options.name,
      });
      this.gitignore.addPatterns("target/");
    }
  }
}
