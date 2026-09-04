/** Filesystem-discovered Rust workspaces and UniFFI binding package wiring. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { string } from "@dbx-tools/shared-core";
import { Project, TextFile, YamlFile, javascript } from "projen";
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
  /** Generate tag-driven cross-platform UniFFI package releases. */
  readonly release?: boolean;
  /** Native release targets; defaults to the maintained GitHub-hosted matrix. */
  readonly releaseTargets?: readonly UniFFIReleaseTarget[];
}

export interface UniFFIReleaseTarget {
  readonly runner: string;
  readonly cargo: string;
  readonly node: string;
  readonly python: string;
  readonly os: "darwin" | "linux" | "win32";
  readonly cpu: "arm64" | "x64";
  readonly libc?: "glibc";
}

/** Native targets built on matching GitHub-hosted runners. */
export const UNIFFI_RELEASE_TARGETS: readonly UniFFIReleaseTarget[] = [
  {
    runner: "ubuntu-22.04",
    cargo: "x86_64-unknown-linux-gnu",
    node: "linux-x64-gnu",
    python: "manylinux_2_35_x86_64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  },
  {
    runner: "ubuntu-24.04-arm",
    cargo: "aarch64-unknown-linux-gnu",
    node: "linux-arm64-gnu",
    python: "manylinux_2_39_aarch64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  },
  {
    runner: "macos-15-intel",
    cargo: "x86_64-apple-darwin",
    node: "darwin-x64",
    python: "macosx_13_0_x86_64",
    os: "darwin",
    cpu: "x64",
  },
  {
    runner: "macos-14",
    cargo: "aarch64-apple-darwin",
    node: "darwin-arm64",
    python: "macosx_11_0_arm64",
    os: "darwin",
    cpu: "arm64",
  },
  {
    runner: "windows-latest",
    cargo: "x86_64-pc-windows-msvc",
    node: "win32-x64-msvc",
    python: "win_amd64",
    os: "win32",
    cpu: "x64",
  },
] as const;

/** Persisted mapping consumed by the focused Rust source watcher. */
export interface RustBindingMapping {
  readonly crate: string;
  readonly rust: string;
  readonly node?: string;
  readonly python?: string;
  readonly nodePackage?: string;
  readonly pythonPackage?: string;
  readonly publishCargo?: boolean;
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
      const packageName = pkg.packageOptions.directory.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      return {
        crate: pkg.crateName,
        rust: `${root}/${pkg.packageOptions.directory}`,
        publishCargo: true,
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
    if ((options.release ?? true) && this.bindingMappings.length > 0) {
      this.addReleaseWorkflow(project, options.releaseTargets ?? UNIFFI_RELEASE_TARGETS);
    }
  }

  private addReleaseWorkflow(
    project: javascript.NodeProject,
    targets: readonly UniFFIReleaseTarget[],
  ): void {
    if (!project.github) return;
    const bindings = this.bindingMappings.map((binding) => ({
      ...binding,
      node: binding.node ?? "",
      python: binding.python ?? "",
      nodePackage: binding.nodePackage ?? "",
      pythonPackage: binding.pythonPackage ?? "",
      publishCargo: binding.publishCargo ?? false,
    }));
    const matrix = bindings.flatMap((binding) =>
      targets.map((target, index) => ({
        binding,
        target: { ...target, facade: index === 0 },
      })),
    );
    new YamlFile(project, ".github/workflows/rust-release.yml", {
      obj: {
        name: "rust-release",
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
          build: {
            name: "${{ matrix.binding.crate }} / ${{ matrix.target.node }}",
            "runs-on": "${{ matrix.target.runner }}",
            strategy: {
              "fail-fast": false,
              matrix: { include: matrix },
            },
            steps: [
              { name: "Checkout", uses: "actions/checkout@v6" },
              { name: "Setup Bun", uses: "oven-sh/setup-bun@v2", with: { "bun-version": "1.3.14" } },
              { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
              {
                name: "Setup Rust",
                uses: "dtolnay/rust-toolchain@stable",
                with: { targets: "${{ matrix.target.cargo }}" },
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
          },
          publish: {
            if: "${{ github.event_name == 'push' }}",
            needs: ["build"],
            "runs-on": "ubuntu-latest",
            strategy: { matrix: { binding: bindings } },
            permissions: { contents: "read", "id-token": "write" },
            environment: { name: "native-${{ matrix.binding.crate }}" },
            steps: [
              { name: "Checkout", uses: "actions/checkout@v6" },
              { name: "Setup Node.js", uses: "actions/setup-node@v6", with: { "registry-url": "https://registry.npmjs.org" } },
              { name: "Setup Bun", uses: "oven-sh/setup-bun@v2", with: { "bun-version": "1.3.14" } },
              { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
              { name: "Install", run: "bun install" },
              {
                name: "Publish workspace npm dependencies",
                if: "${{ matrix.binding.node != '' }}",
                env: {
                  NPM_CONFIG_TOKEN: "${{ secrets.NPM_TOKEN }}",
                  NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
                },
                run: [
                  'VERSION="${GITHUB_REF_NAME#v}"',
                  'bun node_modules/@dbx-tools/projen/tasks/publish.ts "$VERSION" --exclude projen --exclude "${{ matrix.binding.node }}"',
                ].join("\n"),
              },
              { name: "Download packages", uses: "actions/download-artifact@v8", with: { pattern: "${{ matrix.binding.crate }}-*", path: "dist/uniffi", "merge-multiple": true } },
              {
                name: "Publish npm packages",
                env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
                run: "for package in dist/uniffi/npm/*.tgz; do npm publish \"$package\" --access public; done",
              },
              {
                name: "Publish npm facades",
                if: "${{ matrix.binding.node != '' }}",
                env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
                run: "for package in dist/uniffi/npm-facade/*.tgz; do npm publish \"$package\" --access public; done",
              },
              {
                name: "Publish Python wheels",
                if: "${{ matrix.binding.python != '' }}",
                run: "uv publish --trusted-publishing always dist/uniffi/python/*.whl",
              },
              {
                name: "Publish Cargo crate",
                if: "${{ matrix.binding.publishCargo }}",
                env: { CARGO_REGISTRY_TOKEN: "${{ secrets.CARGO_REGISTRY_TOKEN }}" },
                run: "cargo publish --package \"${{ matrix.binding.crate }}\"",
              },
            ],
          },
          "publish-local": {
            if: "${{ github.event_name == 'push' && vars.LOCAL_REPOSITORIES == 'true' }}",
            needs: ["build"],
            "runs-on": ["self-hosted"],
            strategy: { matrix: { binding: bindings } },
            permissions: { contents: "read" },
            steps: [
              { name: "Checkout", uses: "actions/checkout@v6" },
              { name: "Setup uv", uses: "astral-sh/setup-uv@v7" },
              { name: "Setup Rust", uses: "dtolnay/rust-toolchain@stable" },
              { name: "Download packages", uses: "actions/download-artifact@v8", with: { pattern: "${{ matrix.binding.crate }}-*", path: "dist/uniffi", "merge-multiple": true } },
              {
                name: "Publish npm mirror",
                if: "${{ vars.LOCAL_NPM_REGISTRY != '' && matrix.binding.node != '' }}",
                env: { NODE_AUTH_TOKEN: "${{ secrets.LOCAL_NPM_TOKEN }}" },
                run: "for package in dist/uniffi/npm/*.tgz; do npm publish \"$package\" --registry \"${{ vars.LOCAL_NPM_REGISTRY }}\"; done",
              },
              {
                name: "Publish npm facade mirror",
                if: "${{ vars.LOCAL_NPM_REGISTRY != '' && matrix.binding.node != '' }}",
                env: { NODE_AUTH_TOKEN: "${{ secrets.LOCAL_NPM_TOKEN }}" },
                run: "for package in dist/uniffi/npm-facade/*.tgz; do npm publish \"$package\" --registry \"${{ vars.LOCAL_NPM_REGISTRY }}\"; done",
              },
              {
                name: "Publish Python mirror",
                if: "${{ vars.LOCAL_PYPI_PUBLISH_URL != '' && matrix.binding.python != '' }}",
                env: {
                  UV_PUBLISH_USERNAME: "${{ secrets.LOCAL_PYPI_USERNAME }}",
                  UV_PUBLISH_PASSWORD: "${{ secrets.LOCAL_PYPI_PASSWORD }}",
                },
                run: "uv publish --publish-url \"${{ vars.LOCAL_PYPI_PUBLISH_URL }}\" dist/uniffi/python/*.whl",
              },
              {
                name: "Publish Cargo mirror",
                if: "${{ vars.LOCAL_CARGO_REGISTRY != '' && matrix.binding.publishCargo }}",
                run: "cargo login --registry \"${{ vars.LOCAL_CARGO_REGISTRY }}\" \"${{ secrets.LOCAL_CARGO_TOKEN }}\" && cargo publish --package \"${{ matrix.binding.crate }}\" --registry \"${{ vars.LOCAL_CARGO_REGISTRY }}\" --allow-dirty",
              },
            ],
          },
        },
      },
    });
  }
}
