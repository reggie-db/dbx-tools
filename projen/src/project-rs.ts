/** Filesystem-discovered Rust workspaces and UniFFI binding package wiring. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { stringUtils } from "@dbx-tools/shared-core";
import { Component, Project, TextFile, TomlFile, javascript } from "projen";
import {
  RustProject,
  type CargoExampleOptions as RustCargoExampleOptions,
  cargoDependency,
  discoverRustCrates,
  structuredTomlSections,
  type CargoDependency as RustCargoDependency,
  type CargoDependencyOptions as RustCargoDependencyOptions,
  type DBXToolsRustProjectOptions as RustProjectOptions,
  type RustCrateOptions as RustCrateConfiguration,
  type RustCliOptions as RustCliConfiguration,
  type RustOpenApiOptions as RustOpenApiConfiguration,
} from "./_rust-project.ts";
import {
  configureRustReleaseTask,
  independentRustCargoPublishJob,
  independentRustGitHubReleaseJob,
  independentRustNativeNpmPublishJob,
  independentRustNodeFacadePublishJob,
  orderRustBindings,
  planRustRelease,
  releaseBinaryAssetName,
  rustBuildJob,
  rustCargoPublishJob,
  rustGitHubReleaseJob,
  rustNativeNpmPublishJob,
  rustNodeFacadePublishJob,
} from "./_rust-release-workflow.ts";
import { toPosix } from "./packages.ts";
import {
  DBX_TOOLS_LICENSE,
  type DBXToolsJavaScriptProject,
  DBXToolsTypeScriptProject,
  projectRepositoryUrl,
} from "./project-js.ts";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";
import { pythonModuleName, type PythonPackageOptions } from "./project-py.ts";
import { defaultReleaseUnitId, type ReleaseDependencyInput } from "./release-catalog.ts";
import {
  hasNodeRelease,
  independentReleaseSetupSteps,
  registerIndependentPublicationJob,
  tryReleaseWorkflow,
} from "./release.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";
export { discoverRustCrates, hasUniFFIBindings } from "./_rust-project.ts";
export { orderRustBindings } from "./_rust-release-workflow.ts";

export type CargoDependency = RustCargoDependency;
export type CargoDependencyOptions = RustCargoDependencyOptions;
export type CargoExampleOptions = RustCargoExampleOptions;
export type DBXToolsRustProjectOptions = RustProjectOptions;
export type RustCrateOptions = RustCrateConfiguration;
export type RustCliOptions = RustCliConfiguration;
export type RustOpenApiOptions = RustOpenApiConfiguration;

/** Public Rust project facade; implementation lives apart from workspace/release coordination. */
export class DBXToolsRustProject extends RustProject {
  constructor(options: DBXToolsRustProjectOptions) {
    super(options);
  }
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
  readonly packages?: Readonly<Record<string, RustCrateOptions>>;
  readonly nodeRoot?: string;
  readonly pythonRoot?: string;
  readonly pythonModulePrefix?: string;
  /** Default publication policy for discovered crates. Individual packages can override it. */
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

function rustCliRegistrySource(binaries: readonly RustReleaseBinaryMapping[]): string {
  return [
    "// GENERATED by projen - DO NOT EDIT.",
    "// Rust release package options are the source of truth.",
    "",
    `export const RELEASE_BINARY_COMMANDS = ${JSON.stringify(binaries, null, 2)} as const;`,
    "",
  ].join("\n");
}

/** Update only source-less workspace package entries in Cargo.lock. */
export function synchronizeCargoLockVersions(
  content: string,
  packageNames: ReadonlySet<string>,
  version: string,
): string {
  return content
    .split("[[package]]")
    .map((block, index) => {
      if (index === 0 || /^source = /m.test(block)) return block;
      const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
      if (!name || !packageNames.has(name)) return block;
      return block.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
    })
    .join("[[package]]");
}

/** Keep tracked workspace package versions in Cargo.lock aligned with VERSION. */
class RustWorkspaceVersionLock extends Component {
  constructor(
    project: Project,
    private readonly packageNames: ReadonlySet<string>,
    private readonly version: string,
  ) {
    super(project);
  }

  public override postSynthesize(): void {
    const path = join(this.project.outdir, "Cargo.lock");
    if (!existsSync(path)) return;
    const content = readFileSync(path, "utf8");
    const next = synchronizeCargoLockVersions(content, this.packageNames, this.version);
    if (next !== content) writeFileSync(path, next);
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

/** Persisted Rust OpenAPI producer consumed by the shared OpenAPI task. */
export interface RustOpenApiMapping {
  readonly crate: string;
  readonly rust: string;
  readonly output: string;
  readonly binary?: string;
  readonly features: readonly string[];
  readonly noDefaultFeatures: boolean;
}

/** Persisted Rust workspace state consumed by `sync --watch`. */
export interface RustWorkspaceMapping {
  readonly root: string;
  readonly crates: readonly string[];
  readonly bindings: readonly RustBindingMapping[];
  readonly binaries: readonly RustReleaseBinaryMapping[];
  readonly openapi: readonly RustOpenApiMapping[];
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
  readonly hidden: boolean;
  readonly unit: string;
  readonly component: string;
  readonly version: string;
  readonly tagPrefix: string;
  readonly tag: string;
  readonly repository: string;
  /** Cargo crate published or mirrored for `cargo install` when GitHub has no archive. */
  readonly crateName: string;
  /** Feature flags passed to `cargo install --features` for this binary target. */
  readonly cargoFeatures: readonly string[];
  readonly assets: readonly RustReleaseBinaryAssetMapping[];
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
  readonly packageOptions: Readonly<Record<string, RustCrateOptions>>;
  readonly private?: boolean;
  readonly release: boolean;
}

function resolveRustWorkspaceOptions(
  project: javascript.NodeProject,
  options: DBXToolsRustWorkspaceOptions,
): ResolvedRustWorkspaceOptions {
  const dbxToolsProject = isDBXToolsJavaScriptProject()(project) ? project : undefined;
  const scope = stringUtils.toSlug(options.scope ?? dbxToolsProject?.scope ?? project.name);
  return {
    root: options.root ?? "packages/rs",
    nodeRoot: options.nodeRoot ?? "packages/js/node",
    pythonRoot: options.pythonRoot ?? "packages/py",
    scope,
    repository:
      options.repository ??
      projectRepositoryUrl(project) ??
      projectUtils.repositoryUrl(project.outdir) ??
      "",
    nativeTargets: releaseTargets(options),
    pythonModulePrefix: options.pythonModulePrefix ?? scope.replaceAll("-", "_"),
    packageOptions: options.packages ?? {},
    private: options.private,
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
  project: javascript.NodeProject,
  packages: readonly DBXToolsRustProject[],
  resolved: ResolvedRustWorkspaceOptions,
): RustReleaseBinaryMapping[] {
  const commands = new Set<string>();
  const binaries = packages.flatMap((pkg) => {
    const configuredBinaries = [
      ...(pkg.packageOptions.cli
        ? [
            {
              name: pkg.packageOptions.binaryName ?? pkg.crateName,
              defaultCommand: pkg.packageOptions.directory,
              description: pkg.packageOptions.description,
              release: pkg.packageOptions.release,
              excludedOs: pkg.packageOptions.releaseExcludeOs,
              cli: pkg.packageOptions.cli,
              requiredFeatures: undefined,
            },
          ]
        : []),
      ...(pkg.packageOptions.binaries ?? [])
        .filter((binary) => Boolean(binary.cli))
        .map((binary) => ({
          name: binary.name,
          defaultCommand: binary.name,
          description: binary.description ?? pkg.packageOptions.description,
          release: binary.release,
          excludedOs: binary.releaseExcludeOs,
          cli: binary.cli!,
          requiredFeatures: binary.requiredFeatures,
        })),
    ];
    return configuredBinaries.map((binary) => {
      if (!binary.release) {
        throw new Error(`${pkg.crateName} must set release when cli is configured`);
      }
      const configured = binary.cli;
      const command =
        typeof configured === "object" && configured.command
          ? configured.command
          : binary.defaultCommand;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(command)) {
        throw new Error(`Invalid Rust CLI command: ${command}`);
      }
      if (commands.has(command)) {
        throw new Error(`Duplicate Rust CLI command: ${command}`);
      }
      commands.add(command);
      const description =
        (typeof configured === "object" ? configured.description : undefined) ??
        binary.description ??
        pkg.crateName;
      const hidden = typeof configured === "object" && configured.hidden === true;
      const excludedOs = new Set(binary.excludedOs ?? []);
      const binaryName = binary.name;
      const identity = isDBXToolsJavaScriptProject()(project)
        ? project.releaseCatalog.releaseIdentityFor(pkg)
        : {
            component: defaultReleaseUnitId("rust", pkg.crateName),
            version: readWorkspaceVersion(project.outdir),
          };
      const tagPrefix =
        isDBXToolsJavaScriptProject()(project) && project.releaseCatalog.mode === "independent"
          ? `${identity.component}-v`
          : "v";
      return {
        command,
        description,
        binaryName,
        hidden,
        unit: "id" in identity ? identity.id : identity.component,
        component: identity.component,
        version: identity.version,
        tagPrefix,
        tag: `${tagPrefix}${identity.version}`,
        repository: resolved.repository,
        crateName: pkg.crateName,
        cargoFeatures: [...(binary.requiredFeatures ?? [])],
        assets: resolved.nativeTargets
          .filter((target) => !excludedOs.has(target.os))
          .map((target) => ({
            os: target.os,
            cpu: target.cpu,
            name: releaseBinaryAssetName(binaryName, target.node, target.os),
          })),
      };
    });
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
      const packageDirectory = `${stringUtils.toSlug(pkg.packageOptions.directory)}-rs`;
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
      const directory = `${stringUtils.toSlug(pkg.packageOptions.directory)}-rs`;
      const module = pythonModuleName(resolved.pythonModulePrefix, directory);
      const name = `${resolved.scope}-${directory}`;
      return {
        directory,
        name,
        module,
        description: `Python bindings for ${pkg.crateName}`,
        uniffi: true,
        internalDependencies: bindingDependencies(plan, pkg, "python").map(
          (dependency) => `${stringUtils.toSlug(dependency.packageOptions.directory)}-rs`,
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
  return plan.packages
    .filter((pkg) => (pkg.packageOptions.bindings ?? ["node", "python"]).includes("node"))
    .map((binding) => {
      const directory = `${stringUtils.toSlug(binding.packageOptions.directory)}-rs`;
      const version = isDBXToolsJavaScriptProject()(project)
        ? project.releaseCatalog.versionFor(binding)
        : readWorkspaceVersion(project.outdir);
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
            `@${resolved.scope}/${stringUtils.toSlug(dependency.packageOptions.directory)}-rs@workspace:*`,
        ),
      };
    });
}

function createRustPackages(
  project: javascript.NodeProject,
  resolved: ResolvedRustWorkspaceOptions,
): DBXToolsRustProject[] {
  return discoverRustCrates(resolve(project.outdir, resolved.root)).map((directory) => {
    const configured = {
      private: resolved.private,
      ...resolved.packageOptions[directory],
    };
    const name = `${resolved.scope}-${directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
    const version =
      isDBXToolsJavaScriptProject()(project) && project.releaseCatalog.mode === "independent"
        ? project.releaseCatalog.versionForRegistration(
            "rust",
            name,
            `${resolved.root}/${directory}`,
          )
        : undefined;
    return new DBXToolsRustProject({
      parent: project,
      outdir: `${resolved.root}/${directory}`,
      name,
      directory,
      workspaceRoot: resolved.root,
      workspace: true,
      scope: resolved.scope,
      ...(version ? { version } : {}),
      ...configured,
    });
  });
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
    new TomlFile(pkg, "uniffi.toml", {
      marker: false,
      obj: structuredTomlSections({
        "bindings.python": { cdylib_name: pkg.crateName.replaceAll("-", "_") },
        "bindings.typescript": { strictTypeChecking: true },
        ...pkg.packageOptions.uniffiConfig,
        "bindings.python.external_packages": Object.fromEntries(
          dependencies.map((dependency) => [
            dependency.crateName.replaceAll("-", "_"),
            `${pythonModuleName(
              resolved.pythonModulePrefix,
              `${stringUtils.toSlug(dependency.packageOptions.directory)}-rs`,
            )}.bindings`,
          ]),
        ),
      }),
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
  const openapiRoot = join(dirname(resolved.nodeRoot), "openapi");
  return {
    root: resolved.root,
    crates: packages.map((pkg) => `${resolved.root}/${pkg.packageOptions.directory}`),
    bindings,
    binaries,
    openapi: packages.flatMap((pkg) => {
      if (!pkg.packageOptions.openapi) return [];
      const options = pkg.packageOptions.openapi === true ? {} : pkg.packageOptions.openapi;
      return [
        {
          crate: pkg.crateName,
          rust: `${resolved.root}/${pkg.packageOptions.directory}`,
          output: toPosix(join(openapiRoot, pkg.packageOptions.directory)),
          ...(options.binary ? { binary: options.binary } : {}),
          features: [...(options.features ?? [])],
          noDefaultFeatures: options.noDefaultFeatures ?? false,
        },
      ];
    }),
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
      package: {
        ...(!isDBXToolsJavaScriptProject()(project) || project.releaseCatalog.mode === "fixed"
          ? { version: readWorkspaceVersion(project.outdir) }
          : {}),
        edition: options.edition ?? "2021",
        "rust-version": options.rustVersion ?? "1.82",
        license: options.license ?? DBX_TOOLS_LICENSE,
        repository: resolved.repository,
      },
      ...(options.workspaceDependencies
        ? {
            dependencies: Object.fromEntries(
              Object.entries(options.workspaceDependencies).map(([name, value]) => [
                name,
                cargoDependency(value),
              ]),
            ),
          }
        : {}),
    },
  };
  new TomlFile(project, "Cargo.toml", {
    marker: false,
    obj: manifest,
  });
  new TomlFile(project, ".cargo/config.toml", {
    marker: false,
    obj: {
      target: {
        "x86_64-pc-windows-msvc": {
          rustflags: ["-C", "target-feature=+crt-static"],
        },
        "aarch64-pc-windows-msvc": {
          rustflags: ["-C", "target-feature=+crt-static"],
        },
      },
    },
  });
  new RustWorkspaceVersionLock(
    project,
    new Set(packages.map((pkg) => pkg.crateName)),
    readWorkspaceVersion(project.outdir),
  );
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

function rustReleaseDependencies(
  root: DBXToolsJavaScriptProject,
  project: DBXToolsRustProject,
  packages: readonly DBXToolsRustProject[],
  dependencies: Readonly<Record<string, CargoDependency>> | undefined,
  development: boolean,
): ReleaseDependencyInput[] {
  return Object.values(dependencies ?? {}).flatMap((dependency) => {
    if (typeof dependency === "string" || !dependency.path) return [];
    const dependencyPath = resolve(project.outdir, dependency.path);
    const target = packages.find((candidate) => resolve(candidate.outdir) === dependencyPath);
    if (!target) return [];
    const configuredRequirement = dependency.version;
    const requirement = configuredRequirement
      ? /^[0-9]/.test(configuredRequirement)
        ? `^${configuredRequirement}`
        : configuredRequirement
      : `^${root.releaseCatalog.versionFor(target)}`;
    return [
      {
        target: target.crateName,
        kind: development ? ("development" as const) : ("runtime" as const),
        requirement,
        propagation: development ? ("never" as const) : ("outside-range" as const),
        publishOrder: !development,
        internal: true,
      },
    ];
  });
}

function configureIndependentRustVersions(
  project: DBXToolsJavaScriptProject,
  packages: readonly DBXToolsRustProject[],
): void {
  for (const pkg of packages) {
    for (const [section, dependencies] of [
      ["dependencies", pkg.packageOptions.dependencies],
      ["dev-dependencies", pkg.packageOptions.devDependencies],
    ] as const) {
      for (const [name, dependency] of Object.entries(dependencies ?? {})) {
        if (typeof dependency === "string" || !dependency.path) continue;
        const dependencyPath = resolve(pkg.outdir, dependency.path);
        const target = packages.find((candidate) => resolve(candidate.outdir) === dependencyPath);
        if (!target) continue;
        pkg.manifestFile.addOverride(
          `${section}.${name}.version`,
          project.releaseCatalog.versionFor(target),
        );
      }
    }
  }
}

/** Generated Rust workspace plus convention-derived UniFFI binding packages. */
export class DBXToolsRustWorkspace extends Component {
  readonly packages: readonly DBXToolsRustProject[];
  readonly nodePackages: readonly DBXToolsTypeScriptProject[];
  readonly pythonPackages: readonly PythonPackageOptions[];
  readonly bindingMappings: readonly RustBindingMapping[];
  readonly releaseBinaries: readonly RustReleaseBinaryMapping[];
  readonly workspaceMapping: RustWorkspaceMapping;

  constructor(project: javascript.NodeProject, options: DBXToolsRustWorkspaceOptions) {
    super(project);
    const resolved = resolveRustWorkspaceOptions(project, options);
    this.packages = createRustPackages(project, resolved);
    const packageDependencies = createRustPackageDependencyResolver(
      this.packages,
      project,
      options,
    );
    if (isDBXToolsJavaScriptProject()(project)) {
      for (const pkg of this.packages) {
        project.releaseCatalog.registerProject(pkg, {
          language: "rust",
          identity: pkg.crateName,
          publish: !pkg.packageOptions.private || pkg.packageOptions.release === true,
          sourcePaths: [`${toPosix(relative(project.outdir, pkg.outdir))}/src`],
        });
      }
      for (const pkg of this.packages) {
        project.releaseCatalog.configureProject(pkg, {
          dependencies: [
            ...rustReleaseDependencies(
              project,
              pkg,
              this.packages,
              pkg.packageOptions.dependencies,
              false,
            ),
            ...rustReleaseDependencies(
              project,
              pkg,
              this.packages,
              pkg.packageOptions.devDependencies,
              true,
            ),
          ],
        });
      }
      if (project.releaseCatalog.mode === "independent") {
        configureIndependentRustVersions(project, this.packages);
      }
    }
    this.releaseBinaries = planRustReleaseBinaries(project, this.packages, resolved);
    configureRustCliRegistry(project, options.cliRegistryPath, this.releaseBinaries);
    if (isDBXToolsJavaScriptProject()(project)) {
      for (const binary of this.releaseBinaries) {
        project.releaseCatalog.registerArtifact(binary.unit, {
          id: `${binary.unit}:github-binary:${binary.binaryName}`,
          kind: "github-binary",
          name: binary.binaryName,
          generated: true,
          data: {
            targets: resolved.nativeTargets.filter((target) =>
              binary.assets.some((asset) => asset.os === target.os && asset.cpu === target.cpu),
            ),
          },
        });
      }
    }

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
    if (isDBXToolsJavaScriptProject()(project)) {
      for (const mapping of this.bindingMappings) {
        const unit = defaultReleaseUnitId("rust", mapping.crate);
        project.releaseCatalog.addUnit({
          id: unit,
          projectPaths: [mapping.rust, mapping.node, mapping.python].filter(
            (path): path is string => Boolean(path),
          ),
        });
        if (mapping.nodePackage) {
          project.releaseCatalog.registerArtifact(unit, {
            id: `${unit}:npm-facade`,
            kind: "npm",
            name: mapping.nodePackage,
            path: mapping.node,
            generated: true,
          });
          project.releaseCatalog.registerArtifact(unit, {
            id: `${unit}:npm-native`,
            kind: "npm",
            name: `${mapping.nodePackage}-native`,
            generated: true,
            data: { targets: resolved.nativeTargets },
          });
        }
        if (mapping.pythonPackage) {
          project.releaseCatalog.registerArtifact(unit, {
            id: `${unit}:python-wheel`,
            kind: "pypi",
            name: mapping.pythonPackage,
            path: mapping.python,
            generated: true,
            data: { targets: resolved.nativeTargets },
          });
        }
      }
    }
    configureRustWorkspaceFiles(project, this.packages, options, resolved);
    configureRustWorkspaceTasks(project);
    if (releaseEnabled) {
      this.addReleaseWorkflow(project, options, resolved.nativeTargets, packageDependencies);
    }
  }

  private addReleaseWorkflow(
    project: javascript.NodeProject,
    options: DBXToolsRustWorkspaceOptions,
    targets: readonly UniFFIReleaseTarget[],
    packageDependencies: RustPackageDependencyResolver,
  ): void {
    if (!project.github || !isDBXToolsJavaScriptProject()(project)) return;
    const plan = planRustRelease(
      project,
      options,
      targets,
      this.packages,
      this.bindingMappings,
      packageDependencies,
    );
    const workflow = tryReleaseWorkflow(project);
    if (!workflow) {
      throw new Error("Rust release requires the root dbx-tools release mode");
    }
    configureRustReleaseTask(project, plan);
    if (project.releaseCatalog.mode === "independent") {
      if (plan.hasTargetOutputs && plan.targets.length) {
        workflow.addJob("rust-build", rustBuildJob(plan, independentReleaseSetupSteps(project)));
      }
      if (plan.publicCrates.length) {
        workflow.addJob("publish-cargo", independentRustCargoPublishJob(project, plan));
        registerIndependentPublicationJob(workflow, "publish-cargo");
      }
      if (plan.releaseBinaries.length) {
        workflow.addJob("publish-github-release", independentRustGitHubReleaseJob(project, plan));
        registerIndependentPublicationJob(workflow, "publish-github-release");
      }
      if (plan.nodeBindings.length && hasNodeRelease(project)) {
        workflow.addJob("publish-native-npm", independentRustNativeNpmPublishJob(project));
        registerIndependentPublicationJob(workflow, "publish-native-npm");
        workflow.addJob(
          "publish-node-facades",
          independentRustNodeFacadePublishJob(project, plan.nodeBindings),
        );
        registerIndependentPublicationJob(workflow, "publish-node-facades");
      }
      return;
    }
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
