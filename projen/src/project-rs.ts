/** Filesystem-discovered Rust workspaces and UniFFI binding package wiring. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { string } from "@dbx-tools/shared-core";
import { Project, TextFile, YamlFile, javascript } from "projen";
import type { DBXToolsProject } from "./project.ts";
import { DBXToolsTypeScriptProject } from "./project-js.ts";
import type { PythonPackageOptions } from "./project-py.ts";
import { readWorkspaceVersion } from "./workspace-version.ts";
import { mixin } from "../index.ts";
import { isDBXToolsJavaScriptProject, isDBXToolsProject } from "./project-predicate.ts";

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
  readonly private?: boolean;
  /** Generate tag-driven cross-platform UniFFI package releases. */
  readonly release?: boolean;
  /** Native release targets; defaults to the maintained GitHub-hosted matrix. */
  readonly releaseTargets?: readonly UniFFIReleaseTarget[];
  /** Maintained OS/CPU combinations to release. Defaults to every supported target. */
  readonly releasePlatforms?: readonly RustReleasePlatform[];
  /** Workflow name used by downstream release stages. Defaults to `rust-release`. */
  readonly releaseWorkflowName?: string;
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
  RUSTC_WRAPPER: "sccache",
  SCCACHE_GHA_ENABLED: "true",
} as const;

function rustCacheSteps(sharedKey: string): readonly Record<string, unknown>[] {
  return [
    { name: "Setup sccache", uses: "mozilla-actions/sccache-action@v0.0.9" },
    {
      name: "Cache Cargo registry",
      uses: "Swatinem/rust-cache@v2",
      with: { "cache-targets": false, "shared-key": sharedKey },
    },
  ];
}

function releaseTargets(options: DBXToolsRustWorkspaceOptions): readonly UniFFIReleaseTarget[] {
  if (options.releaseTargets && options.releasePlatforms) {
    throw new Error("releaseTargets and releasePlatforms are mutually exclusive");
  }
  if (options.releaseTargets) return options.releaseTargets;
  if (!options.releasePlatforms) return UNIFFI_RELEASE_TARGETS;
  return options.releasePlatforms.map((platform) => {
    const target = UNIFFI_RELEASE_TARGETS.find(
      (candidate) => candidate.os === platform.os && candidate.cpu === platform.cpu,
    );
    if (!target)
      throw new Error(`Unsupported Rust release platform: ${platform.os}-${platform.cpu}`);
    return target;
  });
}

/** Persisted mapping consumed by the focused Rust source watcher. */
export interface RustBindingMapping {
  readonly crate: string;
  readonly rust: string;
  readonly node?: string;
  readonly python?: string;
  readonly nodePackage?: string;
  readonly pythonPackage?: string;
  readonly facadeTarget?: boolean;
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
              ? { name: "uniffi-bindgen", path: "uniffi-bindgen.rs" }
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
      const packageName = pkg.packageOptions.directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      return {
        crate: pkg.crateName,
        rust: `${root}/${pkg.packageOptions.directory}`,
        ...(targets.includes("node")
          ? {
              node: `${nodeRoot}/${pkg.packageOptions.directory}`,
              nodePackage: `@${string.toSlug(options.scope)}/${packageName}`,
            }
          : {}),
        ...(targets.includes("python")
          ? {
              python: `${options.pythonRoot ?? "packages/py"}/${pkg.packageOptions.directory}`,
              pythonPackage: pkg.crateName,
            }
          : {}),
      };
    });
    this.workspaceMapping = {
      root,
      crates: this.packages.map((pkg) => `${root}/${pkg.packageOptions.directory}`),
      bindings: this.bindingMappings,
    };
    if (isDBXToolsJavaScriptProject()(project)) {
      project.dbxToolsConfig.rust = this.workspaceMapping;
    }
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
        trustedPublisher: {
          workflowName: options.releaseWorkflowName ?? "rust-release",
          environment: `native-${pkg.crateName}`,
          artifacts: `platform-specific wheels for ${releaseTargets(options)
            .map((target) => `${target.os}-${target.cpu}`)
            .join(", ")}; all architectures publish to this one PyPI project`,
        },
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
      const releaseTargets = options.releaseTargets ?? UNIFFI_RELEASE_TARGETS;
      if (options.release ?? true) {
        node.package.addField(
          "optionalDependencies",
          Object.fromEntries(
            releaseTargets.map((target) => [
              `@${string.toSlug(options.scope)}/${directory}-${target.node}`,
              readWorkspaceVersion(project.outdir),
            ]),
          ),
        );
      }
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
    if (
      (options.release ?? true) &&
      (this.bindingMappings.length > 0 || this.packages.some((pkg) => pkg.packageOptions.release))
    ) {
      this.addReleaseWorkflow(project, options, releaseTargets(options));
    }
  }

  private addReleaseWorkflow(
    project: javascript.NodeProject,
    options: DBXToolsRustWorkspaceOptions,
    targets: readonly UniFFIReleaseTarget[],
  ): void {
    if (!project.github) return;
    const bindings = this.bindingMappings.map((binding) => ({
      ...binding,
      node: binding.node ?? "",
      python: binding.python ?? "",
      nodePackage: binding.nodePackage ?? "",
      pythonPackage: binding.pythonPackage ?? "",
    }));
    const matrix = bindings.flatMap((binding) =>
      targets.map((target, index) => ({
        binding,
        target: { ...target, facade: index === 0 },
      })),
    );
    const releaseBinaries = this.packages
      .filter((pkg) => pkg.packageOptions.release)
      .map((pkg) => ({
        crate: pkg.crateName,
        binary: pkg.packageOptions.binaryName ?? pkg.crateName,
      }));
    const binaryMatrix = releaseBinaries.flatMap((pkg) =>
      targets.map((target) => ({ package: pkg, target })),
    );
    const buildJob = {
      name: "${{ matrix.binding.crate }} / ${{ matrix.target.node }}",
      "runs-on": "${{ matrix.target.runner }}",
      env: RUST_CACHE_ENV,
      strategy: {
        "fail-fast": false,
        matrix: { include: matrix },
      },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v6" },
        {
          name: "Setup Bun",
          uses: "oven-sh/setup-bun@v2",
          with: { "bun-version": "1.3.14" },
        },
        { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
        {
          name: "Setup Rust",
          uses: "dtolnay/rust-toolchain@stable",
          with: { targets: "${{ matrix.target.cargo }}" },
        },
        ...rustCacheSteps("uniffi-${{ matrix.target.cargo }}"),
        {
          name: "Install Linux native dependencies",
          if: "${{ matrix.target.os == 'linux' }}",
          run: "sudo apt-get update && sudo apt-get install --yes libdbus-1-dev pkg-config",
        },
        { name: "Install", run: "bun install" },
        {
          name: "Build thin native packages",
          shell: "bash",
          env: {
            VERSION: "${{ github.event_name == 'push' && github.ref_name || inputs.version }}",
          },
          run: 'bun node_modules/@dbx-tools/projen/tasks/uniffi-release.ts build --crate "${{ matrix.binding.crate }}" --rust "${{ matrix.binding.rust }}" --node "${{ matrix.binding.node }}" --python "${{ matrix.binding.python }}" --node-package "${{ matrix.binding.nodePackage }}" --python-package "${{ matrix.binding.pythonPackage }}" --cargo-target "${{ matrix.target.cargo }}" --node-triple "${{ matrix.target.node }}" --python-tag "${{ matrix.target.python }}" --os "${{ matrix.target.os }}" --cpu "${{ matrix.target.cpu }}" --libc "${{ matrix.target.libc }}" --facade "${{ matrix.target.facade }}" --version "${VERSION#v}"',
        },
        {
          name: "Upload native packages",
          uses: "actions/upload-artifact@v7",
          with: {
            name: "${{ matrix.binding.crate }}-${{ matrix.target.node }}",
            path: [
              "dist/uniffi/npm/*.tgz",
              "dist/uniffi/npm-facade/*.tgz",
              "dist/uniffi/python/*.whl",
            ].join("\n"),
          },
        },
      ],
    };
    const binaryBuildJob = {
      name: "${{ matrix.package.crate }} / ${{ matrix.target.node }}",
      "runs-on": "${{ matrix.target.runner }}",
      env: RUST_CACHE_ENV,
      strategy: { "fail-fast": false, matrix: { include: binaryMatrix } },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v6" },
        {
          name: "Setup Rust",
          uses: "dtolnay/rust-toolchain@stable",
          with: { targets: "${{ matrix.target.cargo }}" },
        },
        ...rustCacheSteps("binary-${{ matrix.target.cargo }}"),
        {
          name: "Install Linux native dependencies",
          if: "${{ matrix.target.os == 'linux' }}",
          run: "sudo apt-get update && sudo apt-get install --yes libdbus-1-dev pkg-config",
        },
        {
          name: "Build release binary",
          shell: "bash",
          run: [
            'cargo build --release --package "${{ matrix.package.crate }}" --bin "${{ matrix.package.binary }}" --target "${{ matrix.target.cargo }}"',
            "mkdir -p dist/rust-release/stage",
            "SOURCE=\"target/${{ matrix.target.cargo }}/release/${{ matrix.package.binary }}${{ matrix.target.os == 'win32' && '.exe' || '' }}\"",
            "DESTINATION=\"dist/rust-release/stage/${{ matrix.package.binary }}${{ matrix.target.os == 'win32' && '.exe' || '' }}\"",
            'cp "$SOURCE" "$DESTINATION"',
            'if [ "${{ matrix.target.os }}" = "win32" ]; then',
            '  ARCHIVE="dist/rust-release/${{ matrix.package.binary }}-${{ matrix.target.node }}.zip"',
            '  7z a "$ARCHIVE" "$DESTINATION"',
            "else",
            '  ARCHIVE="dist/rust-release/${{ matrix.package.binary }}-${{ matrix.target.node }}.tar.gz"',
            '  tar -C dist/rust-release/stage -czf "$ARCHIVE" "${{ matrix.package.binary }}"',
            "fi",
            "rm -rf dist/rust-release/stage",
          ].join("\n"),
        },
        {
          name: "Upload release binary",
          uses: "actions/upload-artifact@v7",
          with: {
            name: "release-${{ matrix.package.crate }}-${{ matrix.target.node }}",
            path: "dist/rust-release/*",
          },
        },
      ],
    };
    const workflowName = options.releaseWorkflowName ?? "rust-release";
    new YamlFile(project, `.github/workflows/${workflowName}.yml`, {
      obj: {
        name: workflowName,
        on: {
          push: { tags: ["v*"] },
          workflow_dispatch: {
            inputs: {
              version: {
                description: "Version to package during a dry run",
                type: "string",
                default: "0.0.0.dev0",
              },
            },
          },
        },
        permissions: { contents: "read" },
        jobs: {
          ...(matrix.length ? { build: buildJob } : {}),
          ...(binaryMatrix.length ? { "build-binaries": binaryBuildJob } : {}),
          ...(bindings.length
            ? {
                publish: {
                  if: "${{ github.event_name == 'push' }}",
                  needs: ["build"],
                  "runs-on": "ubuntu-latest",
                  strategy: { matrix: { binding: bindings } },
                  permissions: { contents: "read", "id-token": "write" },
                  environment: { name: "native-${{ matrix.binding.crate }}" },
                  steps: [
                    { name: "Checkout", uses: "actions/checkout@v6" },
                    {
                      name: "Setup Node.js",
                      uses: "actions/setup-node@v6",
                      with: { "registry-url": "https://registry.npmjs.org" },
                    },
                    {
                      name: "Setup Bun",
                      uses: "oven-sh/setup-bun@v2",
                      with: { "bun-version": "1.3.14" },
                    },
                    { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
                    { name: "Install", run: "bun install" },
                    {
                      name: "Download packages",
                      uses: "actions/download-artifact@v8",
                      with: {
                        pattern: "${{ matrix.binding.crate }}-*",
                        path: "dist/uniffi",
                        "merge-multiple": true,
                      },
                    },
                    {
                      name: "Publish npm packages",
                      env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
                      run: 'for package in dist/uniffi/npm/*.tgz; do npm publish "$package" --access public; done',
                    },
                    {
                      name: "Publish npm facades",
                      if: "${{ matrix.binding.node != '' }}",
                      env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
                      run: 'for package in dist/uniffi/npm-facade/*.tgz; do npm publish "$package" --access public; done',
                    },
                    {
                      name: "Publish Python wheels",
                      if: "${{ matrix.binding.python != '' }}",
                      run: "uv publish --trusted-publishing always dist/uniffi/python/*.whl",
                    },
                  ],
                },
              }
            : {}),
          "publish-cargo": {
            if: "${{ github.event_name == 'push' }}",
            needs: [matrix.length ? "build" : "build-binaries"],
            "runs-on": "ubuntu-latest",
            permissions: { contents: "read" },
            env: RUST_CACHE_ENV,
            steps: [
              { name: "Checkout", uses: "actions/checkout@v6" },
              { name: "Setup Rust", uses: "dtolnay/rust-toolchain@stable" },
              ...rustCacheSteps("cargo-publish"),
              {
                name: "Install Linux native dependencies",
                run: "sudo apt-get update && sudo apt-get install --yes libdbus-1-dev pkg-config",
              },
              {
                name: "Publish public crates",
                env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" },
                run: "cargo publish --workspace --registry crates-io",
              },
            ],
          },
          "publish-local": {
            if: "${{ github.event_name == 'push' && vars.LOCAL_REPOSITORIES == 'true' }}",
            "runs-on": ["self-hosted"],
            permissions: { contents: "read" },
            env: RUST_CACHE_ENV,
            steps: [
              { name: "Checkout", uses: "actions/checkout@v6" },
              {
                name: "Setup Bun",
                uses: "oven-sh/setup-bun@v2",
                with: { "bun-version": "1.3.14" },
              },
              { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
              { name: "Setup Rust", uses: "dtolnay/rust-toolchain@stable" },
              ...rustCacheSteps("local-${{ runner.os }}-${{ runner.arch }}"),
              { name: "Install", run: "bun install" },
              {
                name: "Build and publish host-native packages",
                run: [
                  'VERSION="${GITHUB_REF_NAME#v}"',
                  'bun node_modules/@dbx-tools/projen/tasks/publish-uniffi-local.ts --version "$VERSION" --registry "${{ vars.LOCAL_NPM_REGISTRY }}" --pypi-publish-url "${{ vars.LOCAL_PYPI_PUBLISH_URL }}" --cargo-registry "${{ vars.LOCAL_CARGO_REGISTRY }}"',
                ].join("\n"),
                env: {
                  NODE_AUTH_TOKEN: "${{ secrets.LOCAL_NPM_TOKEN }}",
                  UV_PUBLISH_USERNAME: "${{ secrets.LOCAL_PYPI_USERNAME }}",
                  UV_PUBLISH_PASSWORD: "${{ secrets.LOCAL_PYPI_PASSWORD }}",
                  CARGO_REGISTRY_TOKEN: "${{ secrets.LOCAL_CARGO_TOKEN }}",
                },
              },
            ],
          },
          ...(binaryMatrix.length
            ? {
                "publish-github-release": {
                  if: "${{ github.event_name == 'push' }}",
                  needs: ["build-binaries"],
                  "runs-on": "ubuntu-latest",
                  permissions: { contents: "write" },
                  steps: [
                    {
                      name: "Download release binaries",
                      uses: "actions/download-artifact@v8",
                      with: {
                        pattern: "release-*",
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
                      },
                    },
                  ],
                },
              }
            : {}),
        },
      },
    });
  }
}
