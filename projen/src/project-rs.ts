/** Filesystem-discovered Rust workspaces and UniFFI binding package wiring. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, project as coreProject } from "@dbx-tools/core";
import { string } from "@dbx-tools/shared-core";
import { Component, Project, TextFile, javascript } from "projen";
import { JobPermission, type Job, type JobStep } from "projen/lib/github/workflows-model";
import { BUN_VERSION } from "./bun-workflow.ts";
import {
  DBX_TOOLS_LICENSE,
  type DBXToolsJavaScriptProject,
  DBXToolsTypeScriptProject,
  projectRepositoryUrl,
} from "./project-js.ts";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";
import { pythonModuleName, type PythonPackageOptions } from "./project-py.ts";
import type { DBXToolsProject } from "./project.ts";
import {
  RELEASE_SHA,
  RELEASE_TAG,
  RELEASE_VERSION,
  releaseSourceSteps,
} from "./release-dispatch.ts";
import {
  hasNodeRelease,
  npmPublishEnvironment,
  nodeReleaseSetupSteps,
  releaseArtifactSteps,
  releaseStageCondition,
  releaseWorkflow,
} from "./release.ts";
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

export interface RustPackageOptions {
  readonly directory: string;
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
  /** Cargo and release executable name. Defaults to the generated package name. */
  readonly binaryName?: string;
  /** Publish this release binary through the generated `dbx` command registry. */
  readonly cli?: boolean | RustCliOptions;
  readonly bindings?: readonly ("node" | "python")[];
  readonly uniffiConfig?: Readonly<Record<string, unknown>>;
}

export interface DBXToolsRustWorkspaceOptions {
  readonly root?: string;
  readonly scope?: string;
  readonly edition?: string;
  /** Minimum supported Rust version recorded in Cargo manifests. */
  readonly rustVersion?: string;
  /** Rust toolchain used by release builds. Defaults to `stable`. */
  readonly releaseRustVersion?: string;
  readonly license?: string;
  readonly repository?: string;
  readonly workspaceDependencies?: Readonly<Record<string, CargoDependency>>;
  readonly packages?: Readonly<Record<string, Omit<RustPackageOptions, "directory">>>;
  readonly nodeRoot?: string;
  readonly pythonRoot?: string;
  readonly pythonModulePrefix?: string;
  readonly private?: boolean;
  /** Generate release-branch-driven cross-platform UniFFI package releases. */
  readonly release?: boolean;
  /** Native release targets; defaults to the maintained GitHub-hosted matrix. */
  readonly releaseTargets?: readonly UniFFIReleaseTarget[];
  /** Maintained OS/CPU combinations to release. Defaults to every supported target. */
  readonly releasePlatforms?: readonly RustReleasePlatform[];
  /** Optional generated TypeScript registry for `cli`-enabled release binaries. */
  readonly cliRegistryPath?: string;
}

export enum RustReleaseOs {
  DARWIN = "darwin",
  LINUX = "linux",
  WINDOWS = "win32",
}

export enum RustReleaseCpu {
  ARM64 = "arm64",
  X64 = "x64",
}

export interface RustReleasePlatform {
  readonly os: RustReleaseOs;
  readonly cpu: RustReleaseCpu;
}

export interface UniFFIReleaseTarget {
  readonly runner: string;
  readonly cargo: string;
  readonly node: string;
  readonly python: string;
  readonly os: RustReleaseOs;
  readonly cpu: RustReleaseCpu;
  readonly libc?: "glibc";
}

/** Native targets built on matching GitHub-hosted runners. */
export const UNIFFI_RELEASE_TARGETS: readonly UniFFIReleaseTarget[] = [
  {
    runner: "ubuntu-22.04",
    cargo: "x86_64-unknown-linux-gnu",
    node: "linux-x64-gnu",
    python: "manylinux_2_35_x86_64",
    os: RustReleaseOs.LINUX,
    cpu: RustReleaseCpu.X64,
    libc: "glibc",
  },
  {
    runner: "ubuntu-24.04-arm",
    cargo: "aarch64-unknown-linux-gnu",
    node: "linux-arm64-gnu",
    python: "manylinux_2_39_aarch64",
    os: RustReleaseOs.LINUX,
    cpu: RustReleaseCpu.ARM64,
    libc: "glibc",
  },
  {
    runner: "macos-15-intel",
    cargo: "x86_64-apple-darwin",
    node: "darwin-x64",
    python: "macosx_13_0_x86_64",
    os: RustReleaseOs.DARWIN,
    cpu: RustReleaseCpu.X64,
  },
  {
    runner: "macos-14",
    cargo: "aarch64-apple-darwin",
    node: "darwin-arm64",
    python: "macosx_11_0_arm64",
    os: RustReleaseOs.DARWIN,
    cpu: RustReleaseCpu.ARM64,
  },
  {
    runner: "windows-latest",
    cargo: "x86_64-pc-windows-msvc",
    node: "win32-x64-msvc",
    python: "win_amd64",
    os: RustReleaseOs.WINDOWS,
    cpu: RustReleaseCpu.X64,
  },
  {
    runner: "windows-11-vs2026-arm",
    cargo: "aarch64-pc-windows-msvc",
    node: "win32-arm64-msvc",
    python: "win_arm64",
    os: RustReleaseOs.WINDOWS,
    cpu: RustReleaseCpu.ARM64,
  },
] as const;

const UBRN_VERSION = "0.31.0-5";
const RELEASE_PLATFORMS_ENV = "DBX_TOOLS_RELEASE_PLATFORMS";
const RUST_CACHE_ENV = {
  CARGO_INCREMENTAL: "0",
  CARGO_TERM_COLOR: "always",
} as const;

function rustCacheSteps(sharedKey: string): readonly JobStep[] {
  return [
    {
      name: "Cache Cargo registry and dependencies",
      id: "cargo_cache",
      uses: "Swatinem/rust-cache@v2.9.2",
      with: {
        "cache-targets": true,
        "cache-workspace-crates": false,
        "add-job-id-key": false,
        "add-rust-environment-hash-key": true,
        "shared-key": sharedKey,
        "save-if": "${{ github.event_name == 'push' }}",
      },
    },
  ];
}

function timedBash(phase: string, command: string): string {
  return [
    "SECONDS=0",
    `trap 'status=$?; echo "phase=${phase} duration_seconds=$SECONDS status=$status"; exit "$status"' EXIT`,
    command,
  ].join("\n");
}

function releaseTargets(options: DBXToolsRustWorkspaceOptions): readonly UniFFIReleaseTarget[] {
  if (options.releaseTargets && options.releasePlatforms) {
    throw new Error("releaseTargets and releasePlatforms are mutually exclusive");
  }
  if (options.releaseTargets) return options.releaseTargets;
  const releasePlatforms =
    options.releasePlatforms ?? releasePlatformsFromEnvironment(process.env[RELEASE_PLATFORMS_ENV]);
  if (!releasePlatforms) return UNIFFI_RELEASE_TARGETS;
  return releasePlatforms.map((platform) => {
    const target = UNIFFI_RELEASE_TARGETS.find(
      (candidate) => candidate.os === platform.os && candidate.cpu === platform.cpu,
    );
    if (!target) {
      throw new Error(`Unsupported Rust release platform: ${platform.os}-${platform.cpu}`);
    }
    return target;
  });
}

function releasePlatformsFromEnvironment(
  value: string | undefined,
): RustReleasePlatform[] | undefined {
  if (!value?.trim()) return undefined;
  return value.split(",").map((entry) => {
    const [os, cpu, ...extra] = entry.split(":").map((part) => part.trim());
    if (
      extra.length ||
      !Object.values(RustReleaseOs).includes(os as RustReleaseOs) ||
      !Object.values(RustReleaseCpu).includes(cpu as RustReleaseCpu)
    ) {
      throw new Error(`Invalid ${RELEASE_PLATFORMS_ENV} entry: ${entry}`);
    }
    return { os: os as RustReleaseOs, cpu: cpu as RustReleaseCpu };
  });
}

function releaseBinaryAssetName(binaryName: string, nodeTarget: string, os: RustReleaseOs): string {
  const extension = os === RustReleaseOs.WINDOWS ? "zip" : "tar.gz";
  return `${binaryName}-${nodeTarget}.${extension}`;
}

function rustCliRegistrySource(binaries: readonly RustReleaseBinaryMapping[]): string {
  return [
    "// GENERATED by projen - DO NOT EDIT.",
    "// Rust release package options are the source of truth.",
    "",
    `export const RUST_RELEASE_BINARY_COMMANDS = ${JSON.stringify(binaries, null, 2)} as const;`,
    "",
  ].join("\n");
}

function uniffiReleaseTaskSource(): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(sourceDirectory, "../tasks/uniffi-release.mjs"),
    resolve(sourceDirectory, "../../tasks/uniffi-release.mjs"),
  ];
  const source = candidates.find(existsSync);
  if (!source) throw new Error("Could not locate tasks/uniffi-release.mjs");
  return readFileSync(source, "utf8");
}

/** Keep tracked workspace package versions in Cargo.lock aligned with VERSION. */
class RustWorkspaceVersionLock extends Component {
  public override postSynthesize(): void {
    exec.spawnSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: this.project.outdir,
      stdout: "ignore",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
  }
}

/** Persisted mapping consumed by the focused Rust source watcher. */
export interface RustBindingMapping {
  readonly crate: string;
  readonly rust: string;
  readonly node?: string;
  readonly python?: string;
  readonly nodePackage?: string;
  readonly pythonPackage?: string;
  readonly pythonModule?: string;
  readonly facadeTarget?: boolean;
  readonly dependencies?: readonly string[];
}

/** Persisted Rust workspace state consumed by `sync --watch`. */
export interface RustWorkspaceMapping {
  readonly root: string;
  readonly crates: readonly string[];
  readonly bindings: readonly RustBindingMapping[];
  readonly binaries: readonly RustReleaseBinaryMapping[];
}

/** One platform archive published for a Rust CLI binary. */
export interface RustReleaseBinaryAssetMapping {
  readonly os: RustReleaseOs;
  readonly cpu: RustReleaseCpu;
  readonly name: string;
}

/** Runtime metadata for one lazily installed Rust CLI binary. */
export interface RustReleaseBinaryMapping {
  readonly command: string;
  readonly description: string;
  readonly binaryName: string;
  readonly repository: string;
  readonly assets: readonly RustReleaseBinaryAssetMapping[];
}

export function orderRustBindings(bindings: readonly RustBindingMapping[]): RustBindingMapping[] {
  const ordered: RustBindingMapping[] = [];
  const visiting = new Set<string>();
  const completed = new Set<string>();
  const visit = (binding: RustBindingMapping): void => {
    if (completed.has(binding.crate)) return;
    if (visiting.has(binding.crate)) {
      throw new Error(`Cyclic Rust binding dependency: ${binding.crate}`);
    }
    visiting.add(binding.crate);
    for (const name of binding.dependencies ?? []) {
      const dependency = bindings.find((candidate) => candidate.crate === name);
      if (!dependency) throw new Error(`Missing Rust binding dependency: ${name}`);
      visit(dependency);
    }
    visiting.delete(binding.crate);
    completed.add(binding.crate);
    ordered.push(binding);
  };
  for (const binding of bindings) visit(binding);
  return ordered;
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

function cargoDependency(
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
    const binary = existsSync(join(this.outdir, "src/main.rs"));
    const binaryName = options.binaryName ?? crateName;
    const manifest: Record<string, unknown> = {
      package: {
        name: crateName,
        version: { workspace: true },
        edition: { workspace: true },
        "rust-version": { workspace: true },
        description: options.description ?? crateName,
        license: { workspace: true },
        repository: { workspace: true },
        ...(options.private ? { publish: false } : {}),
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
      ...(this.uniffi || binary
        ? {
            bin: this.uniffi
              ? { name: `${crateName}-uniffi-bindgen`, path: "uniffi-bindgen.rs" }
              : { name: binaryName, path: "src/main.rs" },
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
                cargoDependency(value, readWorkspaceVersion(parent.outdir)),
              ]),
            ),
          }
        : {}),
      ...(options.devDependencies
        ? {
            "dev-dependencies": Object.fromEntries(
              Object.entries(options.devDependencies).map(([name, value]) => [
                name,
                cargoDependency(value, readWorkspaceVersion(parent.outdir)),
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

function rustPackageDependencies(
  packages: readonly DBXToolsRustProject[],
  pkg: DBXToolsRustProject,
  root: string,
  workspaceDependencies: Readonly<Record<string, CargoDependency>> | undefined,
): DBXToolsRustProject[] {
  return packages.filter(
    (dependency) =>
      dependency !== pkg &&
      Object.entries(pkg.packageOptions.dependencies ?? {}).some(([name, value]) => {
        const resolved =
          typeof value === "object" && value.workspace
            ? (workspaceDependencies?.[name] ?? value)
            : value;
        return (
          name === dependency.crateName ||
          (typeof resolved === "object" &&
            (resolved.package === dependency.crateName ||
              (resolved.path !== undefined &&
                resolve(
                  typeof value === "object" && value.workspace ? root : pkg.outdir,
                  resolved.path,
                ) === dependency.outdir)))
        );
      }),
  );
}

interface ResolvedRustWorkspaceOptions {
  readonly root: string;
  readonly nodeRoot: string;
  readonly pythonRoot: string;
  readonly scope: string;
  readonly repository: string;
  readonly nativeTargets: readonly UniFFIReleaseTarget[];
  readonly pythonModulePrefix: string;
  readonly packageOptions: Readonly<Record<string, Omit<RustPackageOptions, "directory">>>;
  readonly release: boolean;
}

function resolveRustWorkspaceOptions(
  project: javascript.NodeProject,
  options: DBXToolsRustWorkspaceOptions,
): ResolvedRustWorkspaceOptions {
  const dbxToolsProject = isDBXToolsJavaScriptProject()(project) ? project : undefined;
  const scope = string.toSlug(options.scope ?? dbxToolsProject?.scope ?? project.name);
  return {
    root: options.root ?? "packages/rs",
    nodeRoot: options.nodeRoot ?? "packages/js/node",
    pythonRoot: options.pythonRoot ?? "packages/py",
    scope,
    repository:
      options.repository ??
      projectRepositoryUrl(project) ??
      coreProject.repositoryUrl(project.outdir) ??
      "",
    nativeTargets: releaseTargets(options),
    pythonModulePrefix: options.pythonModulePrefix ?? scope.replaceAll("-", "_"),
    packageOptions: options.packages ?? {},
    release: options.release ?? true,
  };
}

type RustPackageDependencyResolver = (pkg: DBXToolsRustProject) => DBXToolsRustProject[];

function createRustPackageDependencyResolver(
  packages: readonly DBXToolsRustProject[],
  project: javascript.NodeProject,
  options: DBXToolsRustWorkspaceOptions,
): RustPackageDependencyResolver {
  return (pkg) =>
    rustPackageDependencies(packages, pkg, project.outdir, options.workspaceDependencies);
}

function planRustReleaseBinaries(
  packages: readonly DBXToolsRustProject[],
  resolved: ResolvedRustWorkspaceOptions,
): RustReleaseBinaryMapping[] {
  const commands = new Set<string>();
  const binaries = packages
    .filter((pkg) => Boolean(pkg.packageOptions.cli))
    .map((pkg) => {
      if (!pkg.packageOptions.release) {
        throw new Error(`${pkg.crateName} must set release when cli is configured`);
      }
      const configured = pkg.packageOptions.cli;
      const command =
        typeof configured === "object" && configured.command
          ? configured.command
          : pkg.packageOptions.directory;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(command)) {
        throw new Error(`Invalid Rust CLI command: ${command}`);
      }
      if (commands.has(command)) {
        throw new Error(`Duplicate Rust CLI command: ${command}`);
      }
      commands.add(command);
      const description =
        (typeof configured === "object" ? configured.description : undefined) ??
        pkg.packageOptions.description ??
        pkg.crateName;
      const excludedOs = new Set(pkg.packageOptions.releaseExcludeOs ?? []);
      const binaryName = pkg.packageOptions.binaryName ?? pkg.crateName;
      return {
        command,
        description,
        binaryName,
        repository: resolved.repository,
        assets: resolved.nativeTargets
          .filter((target) => !excludedOs.has(target.os))
          .map((target) => ({
            os: target.os,
            cpu: target.cpu,
            name: releaseBinaryAssetName(binaryName, target.node, target.os),
          })),
      };
    });
  if (binaries.length && !resolved.repository) {
    throw new Error("A repository URL is required when Rust CLI commands are configured");
  }
  return binaries;
}

function validateRustReleaseGraph(
  packages: readonly DBXToolsRustProject[],
  packageDependencies: RustPackageDependencyResolver,
): void {
  for (const pkg of packages) {
    const excludedOs = new Set(pkg.packageOptions.releaseExcludeOs ?? []);
    if (excludedOs.size && pkg.uniffi) {
      throw new Error(
        `${pkg.crateName} cannot set releaseExcludeOs because UniFFI requires every configured target`,
      );
    }
    for (const dependency of packageDependencies(pkg)) {
      for (const os of dependency.packageOptions.releaseExcludeOs ?? []) {
        if (!excludedOs.has(os)) {
          throw new Error(
            `${pkg.crateName} must exclude ${os} release builds because it depends on ${dependency.crateName}`,
          );
        }
      }
    }
  }
}

interface RustBindingPlan {
  readonly packages: readonly DBXToolsRustProject[];
  readonly mappings: readonly RustBindingMapping[];
  readonly dependencies: ReadonlyMap<
    DBXToolsRustProject,
    Readonly<Record<"node" | "python", readonly DBXToolsRustProject[]>>
  >;
}

function planRustBindings(
  packages: readonly DBXToolsRustProject[],
  packageDependencies: RustPackageDependencyResolver,
  resolved: ResolvedRustWorkspaceOptions,
): RustBindingPlan {
  const bindings = packages.filter((pkg) => pkg.uniffi);
  const dependencies = new Map<
    DBXToolsRustProject,
    Readonly<Record<"node" | "python", readonly DBXToolsRustProject[]>>
  >();
  for (const pkg of bindings) {
    const direct = packageDependencies(pkg);
    dependencies.set(pkg, {
      node: bindings.filter(
        (dependency) =>
          (dependency.packageOptions.bindings ?? ["node", "python"]).includes("node") &&
          direct.includes(dependency),
      ),
      python: bindings.filter(
        (dependency) =>
          (dependency.packageOptions.bindings ?? ["node", "python"]).includes("python") &&
          direct.includes(dependency),
      ),
    });
  }
  const mappings = orderRustBindings(
    bindings.map((pkg) => {
      const targets = pkg.packageOptions.bindings ?? ["node", "python"];
      const packageDirectory = `${string.toSlug(pkg.packageOptions.directory)}-rs`;
      const direct = dependencies.get(pkg);
      const dependencyCrates = [
        ...new Set([...(direct?.node ?? []), ...(direct?.python ?? [])]),
      ].map((dependency) => dependency.crateName);
      return {
        crate: pkg.crateName,
        ...(dependencyCrates.length ? { dependencies: dependencyCrates } : {}),
        rust: `${resolved.root}/${pkg.packageOptions.directory}`,
        ...(targets.includes("node")
          ? {
              node: `${resolved.nodeRoot}/${packageDirectory}`,
              nodePackage: `@${resolved.scope}/${packageDirectory}`,
            }
          : {}),
        ...(targets.includes("python")
          ? {
              python: `${resolved.pythonRoot}/${packageDirectory}`,
              pythonPackage: `${resolved.scope}-${packageDirectory}`,
              pythonModule: pythonModuleName(resolved.pythonModulePrefix, packageDirectory),
            }
          : {}),
      };
    }),
  );
  return { packages: bindings, mappings, dependencies };
}

function bindingDependencies(
  plan: RustBindingPlan,
  pkg: DBXToolsRustProject,
  language: "node" | "python",
): readonly DBXToolsRustProject[] {
  return plan.dependencies.get(pkg)?.[language] ?? [];
}

function planPythonBindingPackages(
  plan: RustBindingPlan,
  resolved: ResolvedRustWorkspaceOptions,
): PythonPackageOptions[] {
  return plan.packages
    .filter((pkg) => (pkg.packageOptions.bindings ?? ["node", "python"]).includes("python"))
    .map((pkg) => {
      const directory = `${string.toSlug(pkg.packageOptions.directory)}-rs`;
      const module = pythonModuleName(resolved.pythonModulePrefix, directory);
      const name = `${resolved.scope}-${directory}`;
      return {
        directory,
        name,
        module,
        description: `Python bindings for ${pkg.crateName}`,
        uniffi: true,
        internalDependencies: bindingDependencies(plan, pkg, "python").map(
          (dependency) => `${string.toSlug(dependency.packageOptions.directory)}-rs`,
        ),
        generatedSources: [
          `src/${module.replaceAll(".", "/")}/bindings.py`,
          `src/${module.replaceAll(".", "/")}/__init__.py`,
        ],
        trustedPublisher: {
          environment: `pypi-${name}`,
          artifacts: `platform-specific wheels for ${resolved.nativeTargets
            .map((target) => `${target.os}-${target.cpu}`)
            .join(", ")}; all architectures publish to this one PyPI project`,
        },
      };
    });
}

interface RustNodeBindingPackagePlan {
  readonly binding: DBXToolsRustProject;
  readonly memberPath: string;
  readonly name: string;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly internalDependencies: readonly string[];
}

function planNodeBindingPackages(
  project: javascript.NodeProject,
  plan: RustBindingPlan,
  resolved: ResolvedRustWorkspaceOptions,
): RustNodeBindingPackagePlan[] {
  const version = readWorkspaceVersion(project.outdir);
  return plan.packages
    .filter((pkg) => (pkg.packageOptions.bindings ?? ["node", "python"]).includes("node"))
    .map((binding) => {
      const directory = `${string.toSlug(binding.packageOptions.directory)}-rs`;
      return {
        binding,
        memberPath: `${resolved.nodeRoot}/${directory}`,
        name: `@${resolved.scope}/${directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
        optionalDependencies: resolved.release
          ? Object.fromEntries(
              resolved.nativeTargets.map((target) => [
                `@${resolved.scope}/${directory}-${target.node}`,
                version,
              ]),
            )
          : {},
        internalDependencies: bindingDependencies(plan, binding, "node").map(
          (dependency) =>
            `@${resolved.scope}/${string.toSlug(dependency.packageOptions.directory)}-rs@workspace:*`,
        ),
      };
    });
}

function createRustPackages(
  project: javascript.NodeProject,
  resolved: ResolvedRustWorkspaceOptions,
): DBXToolsRustProject[] {
  return discoverRustCrates(resolve(project.outdir, resolved.root)).map(
    (directory) =>
      new DBXToolsRustProject(project, resolved.root, resolved.scope, {
        directory,
        ...resolved.packageOptions[directory],
      }),
  );
}

function configureRustCliRegistry(
  project: javascript.NodeProject,
  path: string | undefined,
  binaries: readonly RustReleaseBinaryMapping[],
): void {
  if (binaries.length && !path) {
    throw new Error("cliRegistryPath is required when Rust CLI commands are configured");
  }
  if (!path) return;
  new TextFile(project, path, {
    lines: rustCliRegistrySource(binaries).trimEnd().split("\n"),
  });
}

function configureRustBindingFiles(
  plan: RustBindingPlan,
  resolved: ResolvedRustWorkspaceOptions,
): void {
  for (const pkg of plan.packages) {
    const dependencies = bindingDependencies(plan, pkg, "python");
    if (dependencies.length === 0) continue;
    pkg.tryRemoveFile("uniffi.toml");
    new TextFile(pkg, "uniffi.toml", {
      lines: renderToml({
        "bindings.python": { cdylib_name: pkg.crateName.replaceAll("-", "_") },
        "bindings.typescript": { strictTypeChecking: true },
        ...pkg.packageOptions.uniffiConfig,
        "bindings.python.external_packages": Object.fromEntries(
          dependencies.map((dependency) => [
            dependency.crateName.replaceAll("-", "_"),
            `${pythonModuleName(
              resolved.pythonModulePrefix,
              `${string.toSlug(dependency.packageOptions.directory)}-rs`,
            )}.bindings`,
          ]),
        ),
      })
        .trimEnd()
        .split("\n"),
    });
  }
}

function configureRustBindingIgnores(
  project: javascript.NodeProject,
  bindings: readonly RustBindingMapping[],
): void {
  project.gitignore.addPatterns(
    "!/Cargo.lock",
    "target/",
    ...bindings.flatMap((binding) => [
      ...(binding.node ? [`${binding.node}/src/*${binding.crate.replaceAll("-", "_")}.*`] : []),
      ...(binding.python && binding.pythonModule
        ? [
            `${binding.python}/src/${binding.pythonModule.replaceAll(".", "/")}/bindings.py`,
            `${binding.python}/src/${binding.pythonModule.replaceAll(".", "/")}/*${binding.crate.replaceAll("-", "_")}.*`,
          ]
        : []),
    ]),
  );
  for (const binding of bindings) {
    if (!binding.node) continue;
    project.prettier?.addIgnorePattern(`${binding.node}/src/bindings.ts`);
    project.prettier?.addIgnorePattern(`${binding.node}/src/_bindings*.ts`);
  }
}

function createRustNodeBindingPackages(
  project: javascript.NodeProject,
  plans: readonly RustNodeBindingPackagePlan[],
): DBXToolsTypeScriptProject[] {
  const existing = new Map(
    project.subprojects.map((child) => [relative(project.outdir, child.outdir), child]),
  );
  return plans.map((plan) => {
    const found = existing.get(plan.memberPath);
    const existingNode = found instanceof DBXToolsTypeScriptProject ? found : undefined;
    const node =
      existingNode ??
      new DBXToolsTypeScriptProject({
        parent: project,
        outdir: plan.memberPath,
        name: plan.name,
        tags: ["node"],
      });
    node.package.addField("name", plan.name);
    node.dbxToolsConfig.uniffi = true;
    node.package.addField("description", `Node bindings for ${plan.binding.crateName}`);
    if (Object.keys(plan.optionalDependencies).length) {
      node.package.addField("optionalDependencies", plan.optionalDependencies);
    }
    node.addDeps("@ubjs/core@0.31.0-5", "@ubjs/node@0.31.0-5");
    node.addDeps(...plan.internalDependencies);
    node.addDevDeps(`uniffi-bindgen-react-native@${UBRN_VERSION}`);
    return node;
  });
}

function createRustWorkspaceMapping(
  packages: readonly DBXToolsRustProject[],
  bindings: readonly RustBindingMapping[],
  binaries: readonly RustReleaseBinaryMapping[],
  resolved: ResolvedRustWorkspaceOptions,
): RustWorkspaceMapping {
  return {
    root: resolved.root,
    crates: packages.map((pkg) => `${resolved.root}/${pkg.packageOptions.directory}`),
    bindings,
    binaries,
  };
}

function configureRustWorkspaceFiles(
  project: javascript.NodeProject,
  packages: readonly DBXToolsRustProject[],
  options: DBXToolsRustWorkspaceOptions,
  resolved: ResolvedRustWorkspaceOptions,
): void {
  const manifest: Record<string, unknown> = {
    workspace: {
      members: packages.map((pkg) => `${resolved.root}/${pkg.packageOptions.directory}`),
      "default-members": packages
        .filter((pkg) => !pkg.uniffi)
        .map((pkg) => `${resolved.root}/${pkg.packageOptions.directory}`),
      resolver: "2",
    },
    "workspace.package": {
      version: readWorkspaceVersion(project.outdir),
      edition: options.edition ?? "2021",
      "rust-version": options.rustVersion ?? "1.82",
      license: options.license ?? DBX_TOOLS_LICENSE,
      repository: resolved.repository,
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
    lines: renderToml(manifest).trimEnd().split("\n"),
  });
  new TextFile(project, ".cargo/config.toml", {
    lines: renderToml({
      "target.x86_64-pc-windows-msvc": {
        rustflags: ["-C", "target-feature=+crt-static"],
      },
      "target.aarch64-pc-windows-msvc": {
        rustflags: ["-C", "target-feature=+crt-static"],
      },
    })
      .trimEnd()
      .split("\n"),
  });
  new RustWorkspaceVersionLock(project);
}

function configureRustWorkspaceTasks(project: javascript.NodeProject): void {
  project.addTask("rs:format", { exec: "cargo fmt --all" });
  project.addTask("rs:lint", { exec: "cargo clippy --workspace --all-targets --all-features" });
  project.addTask("rs:test", { exec: "cargo test --workspace" });
  project.addTask("rs:build", { exec: "cargo build --workspace" });
  project.addTask("rs:bindings", {
    exec: "bun node_modules/@dbx-tools/projen/tasks/rust.ts",
    description: "Generate language bindings for UniFFI-enabled Rust crates",
  });
  project.removeTask("rs:bindings:demo");
}

interface RustReleaseBinding extends RustBindingMapping {
  readonly node: string;
  readonly python: string;
  readonly nodePackage: string;
  readonly pythonPackage: string;
}

interface RustReleaseBinaryPlan {
  readonly crate: string;
  readonly binary: string;
  readonly excludedOs: readonly RustReleaseOs[];
}

type RustReleaseTargetPlan = Readonly<Record<string, string | boolean | number>>;

interface RustReleasePlan {
  readonly releaseRustVersion: string;
  readonly releaseTask: string;
  readonly bindings: readonly RustReleaseBinding[];
  readonly nodeBindings: readonly RustReleaseBinding[];
  readonly releaseBinaries: readonly RustReleaseBinaryPlan[];
  readonly publicCrates: readonly string[];
  readonly targets: readonly RustReleaseTargetPlan[];
  readonly hasReleaseExclusions: boolean;
  readonly hasPythonBindings: boolean;
  readonly usesCargoLock: boolean;
  readonly usePreinstalledWindowsRust: boolean;
  readonly hasTargetOutputs: boolean;
}

function planRustRelease(
  project: javascript.NodeProject,
  options: DBXToolsRustWorkspaceOptions,
  targets: readonly UniFFIReleaseTarget[],
  packages: readonly DBXToolsRustProject[],
  bindingMappings: readonly RustBindingMapping[],
): RustReleasePlan {
  const releaseRustVersion = options.releaseRustVersion ?? "stable";
  const bindings = bindingMappings.map((binding) => ({
    ...binding,
    node: binding.node ?? "",
    python: binding.python ?? "",
    nodePackage: binding.nodePackage ?? "",
    pythonPackage: binding.pythonPackage ?? "",
  }));
  const releaseBinaries = packages
    .filter((pkg) => pkg.packageOptions.release)
    .map((pkg) => ({
      crate: pkg.crateName,
      binary: pkg.packageOptions.binaryName ?? pkg.crateName,
      excludedOs: pkg.packageOptions.releaseExcludeOs ?? [],
    }));
  const packageDependencies = createRustPackageDependencyResolver(packages, project, options);
  const publicCrates = orderRustBindings(
    packages
      .filter((pkg) => !pkg.packageOptions.private)
      .map((pkg) => ({
        crate: pkg.crateName,
        rust: pkg.outdir,
        dependencies: packageDependencies(pkg).map((dependency) => dependency.crateName),
      })),
  ).map((pkg) => pkg.crate);
  const hasReleaseExclusions = packages.some((pkg) => pkg.packageOptions.releaseExcludeOs?.length);
  const plannedTargets: RustReleaseTargetPlan[] = targets.map((target) => {
    const cargoExcludes = packages
      .filter((pkg) => pkg.packageOptions.releaseExcludeOs?.includes(target.os))
      .map((pkg) => `--exclude ${pkg.crateName}`)
      .join(" ");
    return {
      runner: target.runner,
      cargo: target.cargo,
      node: target.node,
      python: target.python,
      os: target.os,
      cpu: target.cpu,
      ...(target.libc ? { libc: target.libc } : {}),
      ...(hasReleaseExclusions ? { cargoExcludes } : {}),
    };
  });
  const hasTargetOutputs =
    bindings.length > 0 || releaseBinaries.length > 0 || publicCrates.length > 0;
  if (hasTargetOutputs && plannedTargets.length === 0) {
    throw new Error("Rust release requires at least one target");
  }
  return {
    releaseRustVersion,
    releaseTask: ".projen/uniffi-release.mjs",
    bindings,
    nodeBindings: bindings.filter((binding) => Boolean(binding.node && binding.nodePackage)),
    releaseBinaries,
    publicCrates,
    targets: plannedTargets,
    hasReleaseExclusions,
    hasPythonBindings: bindings.some((binding) => binding.python),
    usesCargoLock: existsSync(join(project.outdir, "Cargo.lock")),
    usePreinstalledWindowsRust: releaseRustVersion === "stable",
    hasTargetOutputs,
  };
}

function configureRustReleaseTask(project: javascript.NodeProject, plan: RustReleasePlan): void {
  if (plan.bindings.length) {
    new TextFile(project, plan.releaseTask, {
      lines: uniffiReleaseTaskSource().trimEnd().split("\n"),
    });
  } else {
    project.tryRemoveFile(plan.releaseTask);
  }
}

function rustBindingCommands(plan: RustReleasePlan): string[] {
  return plan.bindings.map((binding) =>
    [
      `node ${plan.releaseTask} build`,
      `--crate "${binding.crate}"`,
      `--node "${binding.node}"`,
      `--python "${binding.python}"`,
      `--node-package "${binding.nodePackage}"`,
      `--python-package "${binding.pythonPackage}"`,
      `--python-module "${binding.pythonModule}"`,
      '--cargo-target "${{ matrix.cargo }}"',
      '--node-triple "${{ matrix.node }}"',
      '--python-tag "${{ matrix.python }}"',
      '--os "${{ matrix.os }}"',
      '--cpu "${{ matrix.cpu }}"',
      '--libc "${{ matrix.libc }}"',
      '--version "$VERSION"',
      `--output "dist/release/${binding.crate}/\${{ matrix.node }}"`,
      "--skip-build",
    ].join(" \\\n  "),
  );
}

function rustReleaseBinaryCondition(excludedOs: readonly RustReleaseOs[]): string | undefined {
  return excludedOs.length
    ? `\${{ ${excludedOs.map((os) => `matrix.os != '${os}'`).join(" && ")} }}`
    : undefined;
}

function rustBinaryCommands(plan: RustReleasePlan): string[] {
  return plan.releaseBinaries.flatMap((pkg) => {
    const windowsAsset = releaseBinaryAssetName(
      pkg.binary,
      "${{ matrix.node }}",
      RustReleaseOs.WINDOWS,
    );
    const unixAsset = releaseBinaryAssetName(pkg.binary, "${{ matrix.node }}", RustReleaseOs.LINUX);
    const commands = [
      `mkdir -p "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage"`,
      `SOURCE="target/\${{ matrix.cargo }}/release/${pkg.binary}\${{ matrix.os == 'win32' && '.exe' || '' }}"`,
      `DESTINATION="dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage/${pkg.binary}\${{ matrix.os == 'win32' && '.exe' || '' }}"`,
      'cp "$SOURCE" "$DESTINATION"',
      'if [ "${{ matrix.os }}" = "win32" ]; then',
      `  7z a "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/${windowsAsset}" "$DESTINATION"`,
      "else",
      `  tar -C "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage" -czf "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/${unixAsset}" "${pkg.binary}"`,
      "fi",
      `rm -rf "dist/release/${pkg.crate}/\${{ matrix.node }}/binary/stage"`,
    ];
    const excludedCondition = pkg.excludedOs
      .map((os) => `[ "\${{ matrix.os }}" != "${os}" ]`)
      .join(" && ");
    return excludedCondition
      ? [`if ${excludedCondition}; then`, ...commands.map((command) => `  ${command}`), "fi"]
      : commands;
  });
}

function rustArtifactSteps(plan: RustReleasePlan): JobStep[] {
  return [
    ...plan.bindings.flatMap((binding) => [
      ...(binding.node
        ? [
            {
              name: `Upload ${binding.crate} native npm package`,
              uses: "actions/upload-artifact@v7",
              with: {
                name: `${binding.crate}-\${{ matrix.node }}-npm`,
                path: `dist/release/${binding.crate}/\${{ matrix.node }}/npm/*.tgz`,
                "retention-days": 7,
              },
            },
          ]
        : []),
      ...(binding.python
        ? [
            {
              name: `Upload ${binding.crate} Python wheel`,
              uses: "actions/upload-artifact@v7",
              with: {
                name: `${binding.pythonPackage}--\${{ matrix.python }}--python-wheel`,
                path: `dist/release/${binding.crate}/\${{ matrix.node }}/python/*.whl`,
                "retention-days": 7,
              },
            },
          ]
        : []),
    ]),
    ...plan.releaseBinaries.map((pkg) => ({
      name: `Upload ${pkg.crate} release binary`,
      uses: "actions/upload-artifact@v7",
      ...(rustReleaseBinaryCondition(pkg.excludedOs)
        ? { if: rustReleaseBinaryCondition(pkg.excludedOs) }
        : {}),
      with: {
        name: `${pkg.crate}-\${{ matrix.node }}-binary`,
        path: `dist/release/${pkg.crate}/\${{ matrix.node }}/binary/*`,
        "retention-days": 7,
      },
    })),
  ];
}

function rustBuildJob(plan: RustReleasePlan): Job {
  const bindingCommands = rustBindingCommands(plan);
  const binaryCommands = rustBinaryCommands(plan);
  return {
    if: "${{ github.event_name == 'push' || inputs.stage == 'all' }}",
    name: "${{ matrix.node }}",
    needs: ["verify-context"],
    runsOn: ["${{ matrix.runner }}"],
    permissions: { contents: JobPermission.READ },
    env: { ...RUST_CACHE_ENV },
    strategy: {
      failFast: false,
      matrix: { include: [...plan.targets] },
    },
    steps: [
      ...releaseSourceSteps(),
      ...(plan.hasPythonBindings ? [{ name: "Setup uv", uses: "astral-sh/setup-uv@v7" }] : []),
      {
        name: "Setup Rust",
        ...(plan.usePreinstalledWindowsRust ? { if: "${{ matrix.os != 'win32' }}" } : {}),
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
        with: { targets: "${{ matrix.cargo }}" },
      },
      ...(plan.usePreinstalledWindowsRust
        ? [
            {
              name: "Verify preinstalled Windows Rust",
              if: "${{ matrix.os == 'win32' }}",
              shell: "bash",
              run: [
                "rustc --version --verbose",
                "cargo --version",
                'rustup target list --installed | grep -Fx "${{ matrix.cargo }}"',
                'test -f "$(rustc --print sysroot)/lib/rustlib/${{ matrix.cargo }}/bin/rust-lld.exe"',
              ].join("\n"),
            },
          ]
        : []),
      ...rustCacheSteps(`release-\${{ matrix.cargo }}-rust-${plan.releaseRustVersion}`),
      {
        name: "Install Linux native dependencies",
        if: "${{ matrix.os == 'linux' }}",
        run: [
          "sudo rm -f /etc/apt/sources.list.d/google-chrome.list",
          "sudo apt-get update",
          "sudo apt-get install --yes libdbus-1-dev pkg-config",
        ].join("\n"),
      },
      {
        name: "Build Rust outputs",
        shell: "bash",
        env: {
          CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER:
            "${{ matrix.os == 'win32' && 'rust-lld' || '' }}",
        },
        run: timedBash(
          "rust_workspace",
          `cargo build --release --workspace${plan.usesCargoLock ? " --locked" : ""} --target "\${{ matrix.cargo }}"${
            plan.hasReleaseExclusions ? " ${{ matrix.cargoExcludes }}" : ""
          }`,
        ),
      },
      ...(bindingCommands.length
        ? [
            {
              name: "Package UniFFI outputs",
              shell: "bash",
              env: { VERSION: RELEASE_VERSION },
              run: timedBash("uniffi_packaging", bindingCommands.join("\n")),
            },
          ]
        : []),
      ...(binaryCommands.length
        ? [
            {
              name: "Package release binaries",
              shell: "bash",
              run: timedBash("binary_packaging", binaryCommands.join("\n")),
            },
          ]
        : []),
      ...rustArtifactSteps(plan),
    ],
  };
}

function rustCargoPublishJob(plan: RustReleasePlan, local: boolean): Job {
  const registry = local ? '"${{ vars.LOCAL_CARGO_REGISTRY }}"' : "crates-io";
  return {
    if: local
      ? "${{ github.event_name == 'push' && vars.LOCAL_REPOSITORIES == 'true' }}"
      : "${{ github.event_name == 'push' }}",
    needs: ["verify-context", "rust-build"],
    runsOn: [local ? "self-hosted" : "ubuntu-latest"],
    permissions: { contents: JobPermission.READ },
    steps: [
      ...releaseSourceSteps(),
      {
        name: "Setup Rust",
        uses: `dtolnay/rust-toolchain@${plan.releaseRustVersion}`,
      },
      {
        name: local ? "Publish Cargo crates locally" : "Publish public crates",
        env: {
          CARGO_REGISTRY_TOKEN: local
            ? "${{ secrets.LOCAL_CARGO_TOKEN }}"
            : "${{ secrets.CARGO_REGISTRY_TOKEN }}",
        },
        run: plan.publicCrates
          .map((crate) => `cargo publish --package "${crate}" --registry ${registry} --no-verify`)
          .join("\n"),
      },
    ],
  };
}

function rustGitHubReleaseJob(): Job {
  return {
    if: "${{ github.event_name == 'push' }}",
    needs: ["verify-context", "rust-build"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.WRITE },
    steps: [
      {
        name: "Download release binaries",
        uses: "actions/download-artifact@v8",
        with: {
          pattern: "*-binary",
          path: "dist/rust-release",
          "merge-multiple": true,
        },
      },
      {
        name: "Publish GitHub release assets",
        uses: "softprops/action-gh-release@v2",
        with: {
          files: "dist/rust-release/*",
          "generate-release-notes": true,
          tag_name: RELEASE_TAG,
          target_commitish: RELEASE_SHA,
        },
      },
    ],
  };
}

function rustNativeNpmPublishJob(project: DBXToolsJavaScriptProject): Job {
  return {
    if: "${{ always() && needs.verify-context.result == 'success' && needs.rust-build.result != 'failure' && needs.rust-build.result != 'cancelled' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
    needs: ["verify-context", "rust-build"],
    runsOn: ["ubuntu-latest"],
    permissions: {
      actions: JobPermission.READ,
      contents: JobPermission.READ,
      idToken: JobPermission.WRITE,
    },
    timeoutMinutes: 15,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...nodeReleaseSetupSteps(project),
      ...releaseArtifactSteps({
        currentName: "Download native npm packages",
        recoveredName: "Download recovered native npm packages",
        pattern: "*-npm",
        path: "dist/uniffi/native",
      }),
      {
        name: "Publish native npm packages",
        env: { RELEASE_VERSION, ...npmPublishEnvironment() },
        run: 'bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory dist/uniffi/native --version "$RELEASE_VERSION" $DRY_RUN',
      },
    ],
  };
}

function rustNodeFacadePublishJob(
  project: DBXToolsJavaScriptProject,
  bindings: readonly RustReleaseBinding[],
): Job {
  return {
    if: releaseStageCondition("node"),
    needs: ["verify-context", "publish-node"],
    runsOn: ["ubuntu-latest"],
    permissions: { contents: JobPermission.READ, idToken: JobPermission.WRITE },
    timeoutMinutes: 30,
    env: { BUN_VERSION, CI: "true" },
    steps: [
      ...nodeReleaseSetupSteps(project),
      {
        name: "Build and publish UniFFI npm facades",
        env: { RELEASE_VERSION, ...npmPublishEnvironment() },
        run: bindings
          .flatMap((binding) => {
            const output = `dist/uniffi/facades/${binding.crate}`;
            return [
              `node .projen/uniffi-release.mjs facade --node "${binding.node}" --node-package "${binding.nodePackage}" --node-triple "linux-x64-gnu" --version "$RELEASE_VERSION" --output "${output}"`,
              `bun node_modules/@dbx-tools/projen/tasks/publish-npm.ts --directory "${output}/npm-facade" --version "$RELEASE_VERSION" $DRY_RUN`,
            ];
          })
          .join("\n"),
      },
      {
        name: "Smoke test published UniFFI npm facades",
        if: "${{ github.event_name == 'push' && vars.UNIFFI_FACADE_SMOKE == 'true' }}",
        continueOnError: true,
        env: { RELEASE_VERSION },
        run: [
          'SMOKE_DIR="$(mktemp -d)"',
          "trap 'rm -rf \"$SMOKE_DIR\"' EXIT",
          'cd "$SMOKE_DIR"',
          "npm init --yes >/dev/null",
          ...bindings.flatMap((binding) => [
            `npm install --ignore-scripts --no-audit --no-fund --package-lock=false "${binding.nodePackage}@$RELEASE_VERSION"`,
            `node -e 'import("${binding.nodePackage}")'`,
          ]),
        ].join("\n"),
      },
    ],
  };
}

/** Generated Rust workspace plus convention-derived UniFFI binding packages. */
export class DBXToolsRustWorkspace {
  readonly packages: readonly DBXToolsRustProject[];
  readonly nodePackages: readonly DBXToolsTypeScriptProject[];
  readonly pythonPackages: readonly PythonPackageOptions[];
  readonly bindingMappings: readonly RustBindingMapping[];
  readonly releaseBinaries: readonly RustReleaseBinaryMapping[];
  readonly workspaceMapping: RustWorkspaceMapping;

  constructor(project: javascript.NodeProject, options: DBXToolsRustWorkspaceOptions) {
    const resolved = resolveRustWorkspaceOptions(project, options);
    this.packages = createRustPackages(project, resolved);
    const packageDependencies = createRustPackageDependencyResolver(
      this.packages,
      project,
      options,
    );
    this.releaseBinaries = planRustReleaseBinaries(this.packages, resolved);
    configureRustCliRegistry(project, options.cliRegistryPath, this.releaseBinaries);

    const bindingPlan = planRustBindings(this.packages, packageDependencies, resolved);
    validateRustReleaseGraph(this.packages, packageDependencies);
    this.bindingMappings = bindingPlan.mappings;
    configureRustBindingFiles(bindingPlan, resolved);
    const releaseEnabled =
      resolved.release &&
      (this.bindingMappings.length > 0 ||
        this.packages.some((pkg) => pkg.packageOptions.release || !pkg.packageOptions.private));
    this.workspaceMapping = createRustWorkspaceMapping(
      this.packages,
      this.bindingMappings,
      this.releaseBinaries,
      resolved,
    );
    if (isDBXToolsJavaScriptProject()(project)) {
      project.dbxToolsConfig.rust = this.workspaceMapping;
    }
    configureRustBindingIgnores(project, this.bindingMappings);
    this.pythonPackages = planPythonBindingPackages(bindingPlan, resolved);
    this.nodePackages = createRustNodeBindingPackages(
      project,
      planNodeBindingPackages(project, bindingPlan, resolved),
    );
    configureRustWorkspaceFiles(project, this.packages, options, resolved);
    configureRustWorkspaceTasks(project);
    if (releaseEnabled) {
      this.addReleaseWorkflow(project, options, resolved.nativeTargets);
    }
  }

  private addReleaseWorkflow(
    project: javascript.NodeProject,
    options: DBXToolsRustWorkspaceOptions,
    targets: readonly UniFFIReleaseTarget[],
  ): void {
    if (!project.github || !isDBXToolsJavaScriptProject()(project)) return;
    const plan = planRustRelease(project, options, targets, this.packages, this.bindingMappings);
    configureRustReleaseTask(project, plan);
    const workflow = releaseWorkflow(project);
    if (plan.hasTargetOutputs && plan.targets.length) {
      workflow.addJob("rust-build", rustBuildJob(plan));
    }
    if (plan.publicCrates.length) {
      workflow.addJob("publish-cargo", rustCargoPublishJob(plan, false));
      workflow.addJob("publish-local-cargo", rustCargoPublishJob(plan, true));
    }
    if (plan.releaseBinaries.length) {
      workflow.addJob("publish-github-release", rustGitHubReleaseJob());
    }
    if (plan.nodeBindings.length && hasNodeRelease(project)) {
      workflow.addJob("publish-native-npm", rustNativeNpmPublishJob(project));
      const nodeJob = workflow.getJob("publish-node");
      if ("uses" in nodeJob) throw new Error("publish-node must be a workflow job");
      workflow.updateJob("publish-node", {
        ...nodeJob,
        if: "${{ always() && needs.verify-context.result == 'success' && needs.publish-native-npm.result == 'success' && (github.event_name == 'push' || inputs.stage == 'all' || inputs.stage == 'node') }}",
        needs: ["verify-context", "publish-native-npm"],
      });
      workflow.addJob("publish-node-facades", rustNodeFacadePublishJob(project, plan.nodeBindings));
    }
  }
}
