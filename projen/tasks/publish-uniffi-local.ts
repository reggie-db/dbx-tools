#!/usr/bin/env -S bun
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { json, log, object } from "@dbx-tools/shared-core";
import { parse, stringify } from "smol-toml";
import { captureTaskCommand, runTaskCommand, taskCommandSucceeds } from "../src/_task-command.ts";
import { readDbxToolsConfig, repoRoot } from "../src/packages.ts";
import type { RustBindingMapping, RustWorkspaceMapping } from "../src/project-rs.ts";

const logger = log.logger("projen:publish-uniffi-local");

function commandAvailable(command: string): boolean {
  return taskCommandSucceeds(repoRoot, command, ["--version"]);
}

function rustHost(): string {
  const host = captureTaskCommand(repoRoot, "rustc", ["-vV"], { check: true }).match(
    /^host:\s+(.+)$/m,
  )?.[1];
  if (!host) throw new Error("Unable to detect the local Rust target from rustc -vV");
  return host;
}

function pythonTag(): string {
  const value = captureTaskCommand(
    repoRoot,
    "uv",
    [
      "run",
      "--no-project",
      "python",
      "-c",
      "import sysconfig; print(sysconfig.get_platform().replace('-', '_').replace('.', '_'))",
    ],
    { check: true },
  );
  if (!value) throw new Error("Unable to detect the local Python wheel platform tag");
  return value;
}

function nativeTarget(): {
  cpu: "arm64" | "x64";
  libc?: "glibc";
  node: string;
  os: "darwin" | "linux" | "win32";
} {
  const os = platform();
  const machine = arch();
  const cpu = machine === "arm64" ? "arm64" : machine === "x64" ? "x64" : undefined;
  if (!cpu) throw new Error(`Unsupported local architecture: ${machine}`);
  if (os === "darwin") return { os, cpu, node: `darwin-${cpu}` };
  if (os === "win32") return { os, cpu, node: `win32-${cpu}-msvc` };
  if (os === "linux") {
    const libc = rustHost().includes("musl") ? undefined : "glibc";
    return { os, cpu, node: `linux-${cpu}-${libc ? "gnu" : "musl"}`, ...(libc ? { libc } : {}) };
  }
  throw new Error(`Unsupported local platform: ${os}`);
}

function rustConfig(): RustWorkspaceMapping | undefined {
  const value = readDbxToolsConfig(repoRoot)?.rust;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const config = value as Partial<RustWorkspaceMapping>;
  return Array.isArray(config.bindings) ? (config as RustWorkspaceMapping) : undefined;
}

function artifacts(directory: string, suffix: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(directory, name));
}

function cargoVersionExists(crateName: string, version: string, registry: string): boolean {
  return taskCommandSucceeds(repoRoot, "cargo", [
    "info",
    `${crateName}@${version}`,
    "--registry",
    registry,
  ]);
}

interface CargoMetadataPackage {
  dependencies: Array<{ name: string; source?: string | null }>;
  manifest_path: string;
  name: string;
  version: string;
}

function orderedCargoManifests(root: string, config: RustWorkspaceMapping): CargoMetadataPackage[] {
  const configured = new Set(config.crates.map((crate) => resolve(root, crate, "Cargo.toml")));
  const metadata = json.parseRecord(
    captureTaskCommand(
      root,
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps", "--locked"],
      { check: true },
    ),
  );
  if (!metadata || !Array.isArray(metadata.packages)) {
    throw new Error("Cargo metadata did not return workspace packages");
  }
  const packages = metadata.packages.filter(object.isRecord).map((pkg) => {
    if (
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string" ||
      typeof pkg.manifest_path !== "string" ||
      !Array.isArray(pkg.dependencies)
    ) {
      throw new Error("Cargo metadata returned an invalid package");
    }
    return {
      name: pkg.name,
      version: pkg.version,
      manifest_path: resolve(pkg.manifest_path),
      dependencies: pkg.dependencies.filter(object.isRecord).map((dependency) => {
        if (typeof dependency.name !== "string") {
          throw new Error(`Cargo metadata returned an invalid dependency for ${pkg.name}`);
        }
        return {
          name: dependency.name,
          source: typeof dependency.source === "string" ? dependency.source : null,
        };
      }),
    } satisfies CargoMetadataPackage;
  });
  const publishable = new Map(
    packages
      .filter((pkg) => configured.has(pkg.manifest_path))
      .filter((pkg) => {
        const manifest = parse(readFileSync(pkg.manifest_path, "utf8")) as {
          package?: { publish?: boolean };
        };
        return manifest.package?.publish !== false;
      })
      .map((pkg) => [pkg.name, pkg]),
  );
  const ordered: CargoMetadataPackage[] = [];
  const visiting = new Set<string>();
  const completed = new Set<string>();
  const visit = (pkg: CargoMetadataPackage): void => {
    if (completed.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`Cyclic Cargo publication dependency: ${pkg.name}`);
    }
    visiting.add(pkg.name);
    for (const dependency of pkg.dependencies) {
      if (dependency.source) continue;
      const workspaceDependency = publishable.get(dependency.name);
      if (workspaceDependency) visit(workspaceDependency);
    }
    visiting.delete(pkg.name);
    completed.add(pkg.name);
    ordered.push(pkg);
  };
  for (const pkg of publishable.values()) visit(pkg);
  return ordered;
}

function copyCargoWorkspace(config: RustWorkspaceMapping): string {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-local-cargo-"));
  for (const path of ["Cargo.toml", "Cargo.lock", "LICENSE", "README.md", "rust-toolchain.toml"]) {
    const source = join(repoRoot, path);
    if (!existsSync(source)) continue;
    cpSync(source, join(root, path));
  }
  const cargoConfig = join(repoRoot, ".cargo");
  if (existsSync(cargoConfig)) cpSync(cargoConfig, join(root, ".cargo"), { recursive: true });
  for (const crate of config.crates) {
    const source = resolve(repoRoot, crate);
    const destination = resolve(root, relative(repoRoot, source));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  return root;
}

export function projectCargoRegistry(
  document: Record<string, unknown>,
  crateNames: ReadonlySet<string>,
  registry: string,
): void {
  const sections: unknown[] = [
    document.dependencies,
    document["dev-dependencies"],
    document["build-dependencies"],
  ];
  const workspace = document.workspace;
  if (workspace && typeof workspace === "object" && !Array.isArray(workspace)) {
    sections.push((workspace as Record<string, unknown>).dependencies);
  }
  for (const value of sections) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const section = value as Record<string, unknown>;
    for (const crateName of crateNames) {
      const dependency = section[crateName];
      if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) continue;
      const record = dependency as Record<string, unknown>;
      if (record.workspace === true) continue;
      record.registry = registry;
    }
  }
}

function publishCargo(config: RustWorkspaceMapping, registry: string, version: string): void {
  const root = copyCargoWorkspace(config);
  try {
    const packages = orderedCargoManifests(root, config);
    const crateNames = new Set(packages.map((pkg) => pkg.name));
    for (const pkg of packages) {
      if (pkg.version !== version) {
        throw new Error(`${pkg.name} version ${pkg.version} does not match release ${version}`);
      }
    }
    const manifests = [join(root, "Cargo.toml"), ...packages.map((pkg) => pkg.manifest_path)];
    for (const manifest of manifests) {
      const document = parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      projectCargoRegistry(document, crateNames, registry);
      chmodSync(manifest, 0o644);
      writeFileSync(manifest, `${stringify(document).trimEnd()}\n`);
    }
    for (const pkg of packages) {
      if (cargoVersionExists(pkg.name, version, registry)) {
        logger.info(`skip published ${pkg.name} @ ${version}`);
        continue;
      }
      runTaskCommand(root, "cargo", [
        "publish",
        "--manifest-path",
        pkg.manifest_path,
        "--registry",
        registry,
        "--locked",
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function buildAndPublish(
  binding: RustBindingMapping,
  version: string,
  registry: string | undefined,
  pypiPublishUrl: string | undefined,
): void {
  const includeNode = Boolean(registry && binding.node && binding.nodePackage);
  const includePython = Boolean(pypiPublishUrl && binding.python && binding.pythonPackage);
  if (!includeNode && !includePython) return;

  const target = nativeTarget();
  const output = resolve(repoRoot, "dist/uniffi");
  runTaskCommand(repoRoot, "node", [
    resolve(dirname(fileURLToPath(import.meta.url)), "uniffi-release.mjs"),
    "build",
    "--crate",
    binding.crate,
    "--node",
    includeNode ? binding.node! : "",
    "--python",
    includePython ? binding.python! : "",
    "--node-package",
    includeNode ? binding.nodePackage! : "",
    "--python-package",
    includePython ? binding.pythonPackage! : "",
    "--python-module",
    includePython ? binding.pythonModule! : "",
    "--cargo-target",
    rustHost(),
    "--node-triple",
    target.node,
    "--python-tag",
    pythonTag(),
    "--os",
    target.os,
    "--cpu",
    target.cpu,
    "--libc",
    target.libc ?? "",
    "--facade",
    "true",
    "--version",
    version,
    "--output",
    "dist/uniffi",
  ]);

  if (includeNode) {
    const publishNpmScript = resolve(dirname(fileURLToPath(import.meta.url)), "publish-npm.ts");
    for (const directory of [join(output, "npm"), join(output, "npm-facade")]) {
      if (artifacts(directory, ".tgz").length === 0) continue;
      runTaskCommand(repoRoot, process.execPath, [
        publishNpmScript,
        "--directory",
        directory,
        "--version",
        version,
        "--registry",
        registry!,
      ]);
    }
  }
  if (includePython) {
    const wheels = artifacts(join(output, "python"), ".whl");
    if (wheels.length === 0) throw new Error(`No wheel produced for ${binding.crate}`);
    runTaskCommand(repoRoot, "uvx", [
      "--from",
      "devpi-client",
      "devpi",
      "upload",
      "--index",
      pypiPublishUrl!,
      "--from-dir",
      join(output, "python"),
    ]);
  }
}

function main(args: string[] = process.argv.slice(2)): void {
  const parsed = parseArgs({
    args,
    options: {
      version: { type: "string" },
      registry: { type: "string" },
      "pypi-publish-url": { type: "string" },
      "cargo-registry": { type: "string" },
    },
  });
  const version = parsed.values.version;
  if (!version) throw new Error("Missing --version");
  const config = rustConfig();
  if (config?.bindings.length) {
    if (!commandAvailable("cargo") || !commandAvailable("rustc")) {
      throw new Error("Cargo and rustc are required because UniFFI Rust projects were detected");
    }
    for (const binding of config.bindings) {
      buildAndPublish(binding, version, parsed.values.registry, parsed.values["pypi-publish-url"]);
    }
  }
  const cargoRegistry = parsed.values["cargo-registry"];
  if (cargoRegistry && config?.crates.length) {
    publishCargo(config, cargoRegistry, version);
  }
}

if (import.meta.main) main();
