/** Filesystem-discovered Rust workspaces and UniFFI binding package wiring. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { project as coreProject } from "@dbx-tools/core";
import { string } from "@dbx-tools/shared-core";
import { Project, TextFile, YamlFile, javascript } from "projen";
import { BUN_VERSION, bunCacheRestoreSteps, bunCacheSaveStep } from "./bun-workflow.ts";
import type { DBXToolsProject } from "./project.ts";
import {
  DBXToolsTypeScriptProject,
  projectReleaseBranch,
  projectRepositoryUrl,
} from "./project-js.ts";
import { pythonModuleName, type PythonPackageOptions } from "./project-py.ts";
import {
  DOWNSTREAM_RELEASE_EVENT,
  RELEASE_SHA,
  RELEASE_TAG,
  RUST_RELEASE_EVENT,
  releaseSourceSteps,
} from "./release-dispatch.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";
import { isDBXToolsJavaScriptProject } from "./project-predicate.ts";

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

export interface RustPackageOptions {
  readonly directory: string;
  readonly description?: string;
  /** Keep this crate unpublished and out of public docs. */
  readonly private?: boolean;
  /** Build this crate's binary for each target and attach it to the GitHub release. */
  readonly release?: boolean;
  readonly dependencies?: Readonly<Record<string, CargoDependency>>;
  readonly devDependencies?: Readonly<Record<string, CargoDependency>>;
  readonly features?: Readonly<Record<string, readonly string[]>>;
  readonly defaultFeatures?: readonly string[];
  /** Cargo and release executable name. Defaults to the generated package name. */
  readonly binaryName?: string;
  readonly bindings?: readonly ("node" | "python")[];
  readonly nodeDependencies?: readonly string[];
  readonly nodeDevDependencies?: readonly string[];
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
  /** Rust toolchain used to compile the host-side UBRN generator. Defaults to releaseRustVersion. */
  readonly ubrnRustVersion?: string;
  readonly license?: string;
  readonly repository?: string;
  readonly workspaceDependencies?: Readonly<Record<string, CargoDependency>>;
  readonly packages?: Readonly<Record<string, Omit<RustPackageOptions, "directory">>>;
  readonly nodeRoot?: string;
  readonly pythonRoot?: string;
  readonly pythonModulePrefix?: string;
  readonly private?: boolean;
  /** Generate tag-driven cross-platform UniFFI package releases. */
  readonly release?: boolean;
  /** Native release targets; defaults to the maintained GitHub-hosted matrix. */
  readonly releaseTargets?: readonly UniFFIReleaseTarget[];
  /** Maintained OS/CPU combinations to release. Defaults to every supported target. */
  readonly releasePlatforms?: readonly RustReleasePlatform[];
  /** Workflow name used by downstream release stages. Defaults to `rust-release`. */
  readonly releaseWorkflowName?: string;
  /** Tag prefix dispatched into the branch-scoped release workflow. Defaults to `v`. */
  readonly releaseTagPrefix?: string;
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
] as const;

const RUST_CACHE_ENV = {
  CARGO_INCREMENTAL: "0",
  CARGO_TERM_COLOR: "always",
  RUSTC_WRAPPER: "sccache",
  SCCACHE_GHA_ENABLED: "true",
} as const;
const UBRN_VERSION = "0.31.0-5";
const RELEASE_PLATFORMS_ENV = "DBX_TOOLS_RELEASE_PLATFORMS";

function rustCacheSteps(sharedKey: string, idPrefix = ""): readonly Record<string, unknown>[] {
  return [
    {
      name: "Setup sccache",
      id: `${idPrefix}sccache`,
      uses: "mozilla-actions/sccache-action@v0.0.11",
    },
    {
      name: "Cache Cargo registry",
      id: `${idPrefix}cargo_cache`,
      uses: "Swatinem/rust-cache@v2.9.2",
      with: {
        "cache-targets": false,
        "add-job-id-key": false,
        "add-rust-environment-hash-key": false,
        "shared-key": sharedKey,
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
  readonly releaseWorkflow?: string;
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

/** Generated Rust workspace plus convention-derived UniFFI facade packages. */
export class DBXToolsRustWorkspace {
  readonly packages: readonly DBXToolsRustProject[];
  readonly nodePackages: readonly DBXToolsTypeScriptProject[];
  readonly pythonPackages: readonly PythonPackageOptions[];
  readonly bindingMappings: readonly RustBindingMapping[];
  readonly workspaceMapping: RustWorkspaceMapping;

  constructor(project: javascript.NodeProject, options: DBXToolsRustWorkspaceOptions) {
    const root = options.root ?? "packages/rs";
    const nodeRoot = options.nodeRoot ?? "packages/js/node";
    const dbxToolsProject = isDBXToolsJavaScriptProject()(project) ? project : undefined;
    const scope = string.toSlug(options.scope ?? dbxToolsProject?.scope ?? project.name);
    const repository =
      options.repository ??
      projectRepositoryUrl(project) ??
      coreProject.repositoryUrl(project.outdir) ??
      "";
    const pythonModulePrefix = options.pythonModulePrefix ?? scope.replaceAll("-", "_");
    const packageOptions = options.packages ?? {};
    this.packages = discoverRustCrates(resolve(project.outdir, root)).map(
      (directory) =>
        new DBXToolsRustProject(project, root, scope, {
          directory,
          ...packageOptions[directory],
        }),
    );

    const bindings = this.packages.filter((pkg) => pkg.uniffi);
    const bindingDependencies = (pkg: DBXToolsRustProject, language: "node" | "python") =>
      bindings.filter(
        (dependency) =>
          dependency !== pkg &&
          (dependency.packageOptions.bindings ?? ["node", "python"]).includes(language) &&
          Object.entries(pkg.packageOptions.dependencies ?? {}).some(([name, value]) => {
            const resolved =
              typeof value === "object" && value.workspace
                ? (options.workspaceDependencies?.[name] ?? value)
                : value;
            return (
              name === dependency.crateName ||
              (typeof resolved === "object" &&
                (resolved.package === dependency.crateName ||
                  (resolved.path !== undefined &&
                    resolve(
                      typeof value === "object" && value.workspace ? project.outdir : pkg.outdir,
                      resolved.path,
                    ) === dependency.outdir)))
            );
          }),
      );
    this.bindingMappings = orderRustBindings(
      bindings.map((pkg) => {
        const targets = pkg.packageOptions.bindings ?? ["node", "python"];
        const packageName = pkg.packageOptions.directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        const dependencies = [
          ...new Set([...bindingDependencies(pkg, "node"), ...bindingDependencies(pkg, "python")]),
        ].map((dependency) => dependency.crateName);
        return {
          crate: pkg.crateName,
          ...(dependencies.length ? { dependencies } : {}),
          rust: `${root}/${pkg.packageOptions.directory}`,
          ...(targets.includes("node")
            ? {
                node: `${nodeRoot}/${pkg.packageOptions.directory}`,
                nodePackage: `@${scope}/${packageName}`,
              }
            : {}),
          ...(targets.includes("python")
            ? {
                python: `${options.pythonRoot ?? "packages/py"}/${pkg.packageOptions.directory}`,
                pythonPackage: pkg.crateName,
                pythonModule: pythonModuleName(pythonModulePrefix, pkg.packageOptions.directory),
              }
            : {}),
        };
      }),
    );
    for (const pkg of bindings) {
      const dependencies = bindingDependencies(pkg, "python");
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
              `${pythonModuleName(pythonModulePrefix, dependency.packageOptions.directory)}.bindings`,
            ]),
          ),
        })
          .trimEnd()
          .split("\n"),
      });
    }
    const releaseEnabled =
      (options.release ?? true) &&
      (this.bindingMappings.length > 0 ||
        this.packages.some((pkg) => pkg.packageOptions.release || !pkg.packageOptions.private));
    this.workspaceMapping = {
      root,
      crates: this.packages.map((pkg) => `${root}/${pkg.packageOptions.directory}`),
      bindings: this.bindingMappings,
      ...(releaseEnabled ? { releaseWorkflow: options.releaseWorkflowName ?? "rust-release" } : {}),
    };
    if (dbxToolsProject) {
      dbxToolsProject.dbxToolsConfig.rust = this.workspaceMapping;
    }
    project.gitignore.addPatterns(
      "target/",
      ...this.bindingMappings.flatMap((binding) => [
        ...(binding.node ? [`${binding.node}/src/*${binding.crate.replaceAll("-", "_")}.*`] : []),
        ...(binding.python && binding.pythonModule
          ? [
              `${binding.python}/src/${binding.pythonModule.replaceAll(".", "/")}/bindings.py`,
              `${binding.python}/src/${binding.pythonModule.replaceAll(".", "/")}/*${binding.crate.replaceAll("-", "_")}.*`,
            ]
          : []),
      ]),
    );
    for (const binding of this.bindingMappings) {
      if (!binding.node) {
        continue;
      }
      project.prettier?.addIgnorePattern(`${binding.node}/src/bindings.ts`);
      project.prettier?.addIgnorePattern(`${binding.node}/src/_bindings*.ts`);
    }
    this.pythonPackages = bindings
      .filter((pkg) => (pkg.packageOptions.bindings ?? ["node", "python"]).includes("python"))
      .map((pkg) => {
        const module = pythonModuleName(pythonModulePrefix, pkg.packageOptions.directory);
        return {
          directory: pkg.packageOptions.directory,
          name: pkg.crateName,
          module,
          description: `Python bindings for ${pkg.crateName}`,
          uniffi: true,
          internalDependencies: bindingDependencies(pkg, "python").map(
            (dependency) => dependency.packageOptions.directory,
          ),
          generatedSources: [
            `src/${module.replaceAll(".", "/")}/bindings.py`,
            `src/${module.replaceAll(".", "/")}/__init__.py`,
          ],
          trustedPublisher: {
            workflowName: options.releaseWorkflowName ?? "rust-release",
            environment: `pypi-${pkg.crateName}`,
            artifacts: `platform-specific wheels for ${releaseTargets(options)
              .map((target) => `${target.os}-${target.cpu}`)
              .join(", ")}; all architectures publish to this one PyPI project`,
          },
        };
      });

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
      const existingNode = found instanceof DBXToolsTypeScriptProject ? found : undefined;
      const node = existingNode
        ? existingNode
        : new DBXToolsTypeScriptProject({
            parent: project,
            outdir: memberPath,
            name: `@${scope}/${directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
            tags: ["node"],
          });
      node.package.addField(
        "name",
        `@${scope}/${directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`,
      );
      node.dbxToolsConfig.uniffi = true;
      if (!existingNode) {
        node.package.addField("description", `Node bindings for ${binding.crateName}`);
      }
      const nativeTargets = releaseTargets(options);
      if (options.release ?? true) {
        node.package.addField(
          "optionalDependencies",
          Object.fromEntries(
            nativeTargets.map((target) => [
              `@${scope}/${directory}-${target.node}`,
              readWorkspaceVersion(project.outdir),
            ]),
          ),
        );
      }
      node.addDeps("@ubjs/core@0.31.0-5", "@ubjs/node@0.31.0-5");
      node.addDeps(
        ...bindingDependencies(binding, "node").map(
          (dependency) => `@${scope}/${dependency.packageOptions.directory}@workspace:*`,
        ),
      );
      if (binding.packageOptions.nodeDependencies?.length) {
        node.addDeps(...binding.packageOptions.nodeDependencies);
      }
      node.addDevDeps(`uniffi-bindgen-react-native@${UBRN_VERSION}`);
      if (binding.packageOptions.nodeDevDependencies?.length) {
        node.addDevDeps(...binding.packageOptions.nodeDevDependencies);
      }
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
        repository,
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
    const bindingsTask = project.addTask("rs:bindings", {
      exec: "bun node_modules/@dbx-tools/projen/tasks/rust.ts",
      description: "Generate language bindings for UniFFI-enabled Rust crates",
    });
    if (this.bindingMappings.some((binding) => binding.node)) {
      project.tasks.tryFind("pre-compile")?.spawn(bindingsTask);
    }
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
    if (releaseEnabled) {
      this.addReleaseWorkflow(project, options, releaseTargets(options));
    }
  }

  private addReleaseWorkflow(
    project: javascript.NodeProject,
    options: DBXToolsRustWorkspaceOptions,
    targets: readonly UniFFIReleaseTarget[],
  ): void {
    if (!project.github) return;
    const workflowName = options.releaseWorkflowName ?? "rust-release";
    const releaseTagPrefix = options.releaseTagPrefix ?? "v";
    const releaseRustVersion = options.releaseRustVersion ?? "stable";
    const ubrnRustVersion = options.ubrnRustVersion ?? releaseRustVersion;
    const ubrnToolchainInstall =
      ubrnRustVersion === releaseRustVersion
        ? ""
        : `rustup toolchain install ${ubrnRustVersion} --profile minimal\n`;
    const ubrnExecutable =
      "${{ github.workspace }}/.cache/ubrn/uniffi-bindgen-react-native${{ matrix.target.os == 'win32' && '.exe' || '' }}";
    const builtUbrnExecutable =
      "target/ubrn/debug/uniffi-bindgen-react-native${{ matrix.target.os == 'win32' && '.exe' || '' }}";
    const releaseBranch = projectReleaseBranch(project);
    const bindings = this.bindingMappings.map((binding) => ({
      ...binding,
      node: binding.node ?? "",
      python: binding.python ?? "",
      nodePackage: binding.nodePackage ?? "",
      pythonPackage: binding.pythonPackage ?? "",
    }));
    const releaseBinaries = this.packages
      .filter((pkg) => pkg.packageOptions.release)
      .map((pkg) => ({
        crate: pkg.crateName,
        binary: pkg.packageOptions.binaryName ?? pkg.crateName,
      }));
    const publicCrates = this.packages
      .filter((pkg) => !pkg.packageOptions.private)
      .sort((first, second) => {
        const order = this.bindingMappings.map((binding) => binding.crate);
        return order.indexOf(first.crateName) - order.indexOf(second.crateName);
      })
      .map((pkg) => pkg.crateName);
    const targetMatrix = targets.map((target, index) => ({
      target: { ...target, facade: index === 0 },
    }));
    const hasNodeBindings = bindings.some((binding) => binding.node);
    const hasPythonBindings = bindings.some((binding) => binding.python);
    const facadeCondition = "matrix.target.facade";
    const facadeCacheMissCondition =
      "matrix.target.facade && steps.ubrn_cache.outputs.cache-hit != 'true'";
    const usePreinstalledWindowsRust = releaseRustVersion === "stable";
    const hasTargetOutputs =
      bindings.length > 0 || releaseBinaries.length > 0 || publicCrates.length > 0;
    if (hasTargetOutputs && targetMatrix.length === 0) {
      throw new Error("Rust release requires at least one target");
    }
    const releaseTask = ".projen/uniffi-release.mjs";
    if (bindings.length) {
      new TextFile(project, releaseTask, {
        lines: uniffiReleaseTaskSource().trimEnd().split("\n"),
      });
    } else {
      project.tryRemoveFile(releaseTask);
    }
    const bindingCommands = bindings.map((binding) =>
      [
        `node ${releaseTask} build`,
        `--crate "${binding.crate}"`,
        `--node "${binding.node}"`,
        `--python "${binding.python}"`,
        `--node-package "${binding.nodePackage}"`,
        `--python-package "${binding.pythonPackage}"`,
        ...(binding.node
          ? ['--node-generator "projen/tasks/uniffi.ts"', '--ubrn "$UBRN_EXECUTABLE"']
          : []),
        '--cargo-target "${{ matrix.target.cargo }}"',
        '--node-triple "${{ matrix.target.node }}"',
        '--python-tag "${{ matrix.target.python }}"',
        '--os "${{ matrix.target.os }}"',
        '--cpu "${{ matrix.target.cpu }}"',
        '--libc "${{ matrix.target.libc }}"',
        '--facade "${{ matrix.target.facade }}"',
        `--version "\${VERSION#${releaseTagPrefix}}"`,
        `--output "dist/release/${binding.crate}/\${{ matrix.target.node }}"`,
        "--skip-build",
      ].join(" \\\n  "),
    );
    const binaryCommands = releaseBinaries.flatMap((pkg) => [
      `mkdir -p "dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/stage"`,
      `SOURCE="target/\${{ matrix.target.cargo }}/release/${pkg.binary}\${{ matrix.target.os == 'win32' && '.exe' || '' }}"`,
      `DESTINATION="dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/stage/${pkg.binary}\${{ matrix.target.os == 'win32' && '.exe' || '' }}"`,
      'cp "$SOURCE" "$DESTINATION"',
      'if [ "${{ matrix.target.os }}" = "win32" ]; then',
      `  7z a "dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/${pkg.binary}-\${{ matrix.target.node }}.zip" "$DESTINATION"`,
      "else",
      `  tar -C "dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/stage" -czf "dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/${pkg.binary}-\${{ matrix.target.node }}.tar.gz" "${pkg.binary}"`,
      "fi",
      `rm -rf "dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/stage"`,
    ]);
    const artifactSteps = [
      ...bindings.flatMap((binding) => [
        ...(binding.node
          ? [
              {
                name: `Upload ${binding.crate} native npm package`,
                uses: "actions/upload-artifact@v7",
                with: {
                  name: `${binding.crate}-\${{ matrix.target.node }}-npm`,
                  path: `dist/release/${binding.crate}/\${{ matrix.target.node }}/npm/*.tgz`,
                },
              },
              {
                name: `Upload ${binding.crate} npm facade`,
                if: "${{ matrix.target.facade }}",
                uses: "actions/upload-artifact@v7",
                with: {
                  name: `${binding.crate}-npm-facade`,
                  path: `dist/release/${binding.crate}/\${{ matrix.target.node }}/npm-facade/*.tgz`,
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
                  name: `${binding.crate}-\${{ matrix.target.python }}-python-wheel`,
                  path: `dist/release/${binding.crate}/\${{ matrix.target.node }}/python/*.whl`,
                },
              },
            ]
          : []),
      ]),
      ...releaseBinaries.map((pkg) => ({
        name: `Upload ${pkg.crate} release binary`,
        uses: "actions/upload-artifact@v7",
        with: {
          name: `${pkg.crate}-\${{ matrix.target.node }}-binary`,
          path: `dist/release/${pkg.crate}/\${{ matrix.target.node }}/binary/*`,
        },
      })),
    ];
    const buildJob = {
      name: "${{ matrix.target.node }}",
      needs: ["verify-context"],
      "runs-on": "${{ matrix.target.runner }}",
      env: {
        ...RUST_CACHE_ENV,
        BUN_VERSION,
        SCCACHE_GHA_VERSION: `release-\${{ matrix.target.cargo }}-rust-${releaseRustVersion}`,
      },
      strategy: {
        "fail-fast": false,
        matrix: { include: targetMatrix },
      },
      steps: [
        ...releaseSourceSteps(),
        ...(hasPythonBindings ? [{ name: "Setup uv", uses: "astral-sh/setup-uv@v7" }] : []),
        {
          name: "Setup Rust",
          ...(usePreinstalledWindowsRust ? { if: "${{ matrix.target.os != 'win32' }}" } : {}),
          uses: `dtolnay/rust-toolchain@${releaseRustVersion}`,
          with: { targets: "${{ matrix.target.cargo }}" },
        },
        ...(usePreinstalledWindowsRust
          ? [
              {
                name: "Verify preinstalled Windows Rust",
                if: "${{ matrix.target.os == 'win32' }}",
                shell: "bash",
                run: [
                  "rustc --version --verbose",
                  "cargo --version",
                  'rustup target list --installed | grep -Fx "${{ matrix.target.cargo }}"',
                  'test -f "$(rustc --print sysroot)/lib/rustlib/${{ matrix.target.cargo }}/bin/rust-lld.exe"',
                ].join("\n"),
              },
            ]
          : []),
        ...rustCacheSteps(`release-\${{ matrix.target.cargo }}-rust-${releaseRustVersion}`),
        ...(hasNodeBindings
          ? [
              {
                name: "Restore UBRN executable",
                id: "ubrn_cache",
                if: "${{ matrix.target.facade }}",
                uses: "actions/cache/restore@v5",
                with: {
                  path: ".cache/ubrn",
                  key: `ubrn-executable-\${{ runner.os }}-\${{ runner.arch }}-rust-${ubrnRustVersion}-${UBRN_VERSION}`,
                },
              },
            ]
          : []),
        ...(hasNodeBindings
          ? bunCacheRestoreSteps(project, {
              setupCondition: facadeCondition,
              condition: facadeCacheMissCondition,
            })
          : []),
        {
          name: "Log cache configuration",
          shell: "bash",
          run: [
            `echo "cargo_cache_namespace=release-\${{ matrix.target.cargo }}-rust-${releaseRustVersion}"`,
            'echo "cargo_cache_hit=${{ steps.cargo_cache.outputs.cache-hit }}"',
            'echo "sccache_scope=${{ github.ref }}"',
            'echo "sccache_namespace=${SCCACHE_GHA_VERSION}"',
            `echo "ubrn_rust_toolchain=${ubrnRustVersion}"`,
            ...(hasNodeBindings
              ? [
                  `echo "ubrn_executable_cache_key=ubrn-executable-\${{ runner.os }}-\${{ runner.arch }}-rust-${ubrnRustVersion}-${UBRN_VERSION}"`,
                  'echo "ubrn_executable_cache_hit=${{ steps.ubrn_cache.outputs.cache-hit }}"',
                ]
              : []),
          ].join("\n"),
        },
        {
          name: "Install Linux native dependencies",
          if: "${{ matrix.target.os == 'linux' }}",
          run: "sudo apt-get update && sudo apt-get install --yes libdbus-1-dev pkg-config",
        },
        ...(hasNodeBindings
          ? [
              {
                name: "Install Node tooling",
                if: "${{ matrix.target.facade && steps.ubrn_cache.outputs.cache-hit != 'true' }}",
                shell: "bash",
                run: timedBash("node_tooling", "bun install"),
              },
              bunCacheSaveStep({
                condition: facadeCacheMissCondition,
              }),
            ]
          : []),
        ...(hasNodeBindings
          ? [
              {
                name: "Prepare UBRN generator",
                if: "${{ matrix.target.facade && steps.ubrn_cache.outputs.cache-hit != 'true' }}",
                env: {
                  CARGO_TARGET_DIR: "${{ github.workspace }}/target/ubrn",
                  UBRN_EXECUTABLE: ubrnExecutable,
                },
                shell: "bash",
                run: timedBash(
                  "ubrn_generator",
                  [
                    `${ubrnToolchainInstall}cargo +${ubrnRustVersion} build --manifest-path node_modules/uniffi-bindgen-react-native/crates/ubrn_cli/Cargo.toml`,
                    'mkdir -p "$(dirname "$UBRN_EXECUTABLE")"',
                    `cp "${builtUbrnExecutable}" "$UBRN_EXECUTABLE"`,
                    'chmod +x "$UBRN_EXECUTABLE"',
                  ].join("\n"),
                ),
              },
              {
                name: "Verify UBRN executable",
                if: "${{ matrix.target.facade }}",
                env: { UBRN_EXECUTABLE: ubrnExecutable },
                shell: "bash",
                run: 'test -f "$UBRN_EXECUTABLE"',
              },
              {
                name: "Save UBRN executable",
                if: "${{ matrix.target.facade && steps.ubrn_cache.outputs.cache-hit != 'true' }}",
                uses: "actions/cache/save@v5",
                with: {
                  path: ".cache/ubrn",
                  key: "${{ steps.ubrn_cache.outputs.cache-primary-key }}",
                },
              },
            ]
          : []),
        {
          name: "Build Rust outputs",
          shell: "bash",
          env: {
            CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER:
              "${{ matrix.target.os == 'win32' && 'rust-lld' || '' }}",
          },
          run: timedBash(
            "rust_workspace",
            'cargo build --release --workspace --target "${{ matrix.target.cargo }}"',
          ),
        },
        ...(bindingCommands.length
          ? [
              {
                name: "Package UniFFI outputs",
                shell: "bash",
                env: {
                  VERSION: RELEASE_TAG,
                  ...(hasNodeBindings
                    ? {
                        UBRN_EXECUTABLE: ubrnExecutable,
                      }
                    : {}),
                },
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
        ...artifactSteps,
        {
          name: "Log sccache statistics",
          if: "${{ always() }}",
          shell: "bash",
          run: '"${SCCACHE_PATH}" --show-stats',
        },
      ],
    };
    const bindingPublishJobs = Object.fromEntries(
      bindings.map((binding) => [
        `publish-${binding.crate}`,
        {
          if: "${{ github.event_name == 'repository_dispatch' }}",
          needs: [
            "build",
            ...(binding.dependencies ?? []).map((dependency) => `publish-${dependency}`),
          ],
          "runs-on": "ubuntu-latest",
          permissions: {
            contents: "read",
            ...(binding.python ? { "id-token": "write" } : {}),
          },
          ...(binding.python ? { environment: { name: `pypi-${binding.crate}` } } : {}),
          steps: [
            ...(binding.node
              ? [
                  {
                    name: "Setup Node.js",
                    uses: "actions/setup-node@v6",
                    with: { "registry-url": "https://registry.npmjs.org" },
                  },
                  {
                    name: "Download native npm packages",
                    uses: "actions/download-artifact@v8",
                    with: {
                      pattern: `${binding.crate}-*-npm`,
                      path: "dist/npm",
                      "merge-multiple": true,
                    },
                  },
                  {
                    name: "Download npm facade",
                    uses: "actions/download-artifact@v8",
                    with: {
                      name: `${binding.crate}-npm-facade`,
                      path: "dist/npm-facade",
                    },
                  },
                  {
                    name: "Publish native npm packages",
                    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
                    run: 'for package in dist/npm/*.tgz; do npm publish "$package" --access public; done',
                  },
                  {
                    name: "Publish npm facade",
                    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
                    run: 'for package in dist/npm-facade/*.tgz; do npm publish "$package" --access public; done',
                  },
                ]
              : []),
            ...(binding.python
              ? [
                  { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
                  {
                    name: "Download Python wheels",
                    uses: "actions/download-artifact@v8",
                    with: {
                      pattern: `${binding.crate}-*-python-wheel`,
                      path: "dist/python",
                      "merge-multiple": true,
                    },
                  },
                  {
                    name: "Publish Python wheels",
                    run: "uv publish --trusted-publishing always dist/python/*.whl",
                  },
                ]
              : []),
          ],
        },
      ]),
    );
    const releaseCompletionJobs = [
      "build",
      ...bindings.map((binding) => `publish-${binding.crate}`),
      ...(publicCrates.length ? ["publish-cargo"] : []),
      ...(releaseBinaries.length ? ["publish-github-release"] : []),
    ];
    new YamlFile(project, `.github/workflows/${workflowName}.yml`, {
      obj: {
        name: workflowName,
        "run-name": `${workflowName} ${RELEASE_TAG}`,
        on: {
          repository_dispatch: {
            types: [RUST_RELEASE_EVENT],
          },
          workflow_dispatch: {
            inputs: {
              release_tag: {
                description: "Annotated release tag to build",
                type: "string",
                required: true,
              },
              expected_sha: {
                description: "Commit the release tag must reference",
                type: "string",
                required: true,
              },
            },
          },
        },
        concurrency: {
          group: workflowName,
          "cancel-in-progress": true,
        },
        permissions: { contents: "read" },
        jobs: {
          "verify-context": {
            "runs-on": "ubuntu-latest",
            steps: [
              {
                name: "Require the default branch cache scope",
                shell: "bash",
                env: {
                  RELEASE_BRANCH: releaseBranch,
                },
                run: 'test "$GITHUB_REF_NAME" = "$RELEASE_BRANCH"',
              },
              {
                name: "Write release metadata",
                shell: "bash",
                env: {
                  RELEASE_TAG,
                  EXPECTED_SHA: RELEASE_SHA,
                },
                run: [
                  "mkdir -p .release",
                  'printf "%s\\n" "$RELEASE_TAG" > .release/tag',
                  'printf "%s\\n" "$EXPECTED_SHA" > .release/sha',
                ].join("\n"),
              },
              {
                name: "Upload release metadata",
                uses: "actions/upload-artifact@v7",
                with: {
                  name: "release-metadata",
                  path: ".release",
                },
              },
            ],
          },
          ...(hasTargetOutputs && targetMatrix.length ? { build: buildJob } : {}),
          ...bindingPublishJobs,
          ...(publicCrates.length
            ? {
                "publish-cargo": {
                  if: "${{ github.event_name == 'repository_dispatch' }}",
                  needs: ["build"],
                  "runs-on": "ubuntu-latest",
                  permissions: { contents: "read" },
                  steps: [
                    ...releaseSourceSteps(),
                    {
                      name: "Setup Rust",
                      uses: `dtolnay/rust-toolchain@${releaseRustVersion}`,
                    },
                    {
                      name: "Publish public crates",
                      env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" },
                      run: publicCrates
                        .map(
                          (crate) =>
                            `cargo publish --package "${crate}" --registry crates-io --no-verify`,
                        )
                        .join("\n"),
                    },
                  ],
                },
              }
            : {}),
          ...(bindings.length
            ? {
                "publish-local-bindings": {
                  if: "${{ github.event_name == 'repository_dispatch' && vars.LOCAL_REPOSITORIES == 'true' }}",
                  needs: ["build"],
                  "runs-on": ["self-hosted"],
                  permissions: { contents: "read" },
                  steps: [
                    ...(hasNodeBindings
                      ? [
                          {
                            name: "Setup Node.js",
                            uses: "actions/setup-node@v6",
                            with: {
                              "registry-url": "${{ vars.LOCAL_NPM_REGISTRY }}",
                            },
                          },
                          {
                            name: "Download native npm packages",
                            uses: "actions/download-artifact@v8",
                            with: {
                              pattern: "*-npm",
                              path: "dist/npm",
                              "merge-multiple": true,
                            },
                          },
                          {
                            name: "Download npm facades",
                            uses: "actions/download-artifact@v8",
                            with: {
                              pattern: "*-npm-facade",
                              path: "dist/npm-facade",
                              "merge-multiple": true,
                            },
                          },
                          {
                            name: "Publish npm packages locally",
                            env: {
                              NODE_AUTH_TOKEN: "${{ secrets.LOCAL_NPM_TOKEN }}",
                            },
                            run: [
                              'for package in dist/npm/*.tgz; do npm publish "$package" --access public; done',
                              'for package in dist/npm-facade/*.tgz; do npm publish "$package" --access public; done',
                            ].join("\n"),
                          },
                        ]
                      : []),
                    ...(hasPythonBindings
                      ? [
                          { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
                          {
                            name: "Download Python wheels",
                            uses: "actions/download-artifact@v8",
                            with: {
                              pattern: "*-python-wheel",
                              path: "dist/python",
                              "merge-multiple": true,
                            },
                          },
                          {
                            name: "Publish Python wheels locally",
                            env: {
                              UV_PUBLISH_USERNAME: "${{ secrets.LOCAL_PYPI_USERNAME }}",
                              UV_PUBLISH_PASSWORD: "${{ secrets.LOCAL_PYPI_PASSWORD }}",
                            },
                            run: 'uv publish --publish-url "${{ vars.LOCAL_PYPI_PUBLISH_URL }}" dist/python/*.whl',
                          },
                        ]
                      : []),
                  ],
                },
              }
            : {}),
          ...(publicCrates.length
            ? {
                "publish-local-cargo": {
                  if: "${{ github.event_name == 'repository_dispatch' && vars.LOCAL_REPOSITORIES == 'true' }}",
                  needs: ["build"],
                  "runs-on": ["self-hosted"],
                  permissions: { contents: "read" },
                  steps: [
                    ...releaseSourceSteps(),
                    {
                      name: "Setup Rust",
                      uses: `dtolnay/rust-toolchain@${releaseRustVersion}`,
                    },
                    {
                      name: "Publish Cargo crates locally",
                      env: {
                        CARGO_REGISTRY_TOKEN: "${{ secrets.LOCAL_CARGO_TOKEN }}",
                      },
                      run: publicCrates
                        .map(
                          (crate) =>
                            `cargo publish --package "${crate}" --registry "\${{ vars.LOCAL_CARGO_REGISTRY }}" --no-verify`,
                        )
                        .join("\n"),
                    },
                  ],
                },
              }
            : {}),
          ...(releaseBinaries.length
            ? {
                "publish-github-release": {
                  if: "${{ github.event_name == 'repository_dispatch' }}",
                  needs: ["build"],
                  "runs-on": "ubuntu-latest",
                  permissions: { contents: "write" },
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
                },
              }
            : {}),
          "dispatch-downstream": {
            if: "${{ github.event_name == 'repository_dispatch' }}",
            needs: releaseCompletionJobs,
            "runs-on": "ubuntu-latest",
            permissions: { contents: "write" },
            steps: [
              {
                name: "Dispatch downstream releases",
                shell: "bash",
                env: {
                  GH_TOKEN: "${{ github.token }}",
                  RELEASE_TAG,
                  EXPECTED_SHA: RELEASE_SHA,
                  RELEASE_EVENT: DOWNSTREAM_RELEASE_EVENT,
                },
                run: [
                  [
                    'gh api --method POST "repos/$GITHUB_REPOSITORY/dispatches"',
                    '--raw-field event_type="$RELEASE_EVENT"',
                    '--raw-field "client_payload[release_tag]=$RELEASE_TAG"',
                    '--raw-field "client_payload[expected_sha]=$EXPECTED_SHA"',
                  ].join(" \\\n  "),
                ].join("\n"),
              },
            ],
          },
        },
      },
    });
  }
}
