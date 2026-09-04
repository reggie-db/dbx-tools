#!/usr/bin/env -S bun
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { readDbxToolsConfig, repoRoot } from "../src/packages.ts";
import type { RustBindingMapping, RustWorkspaceMapping } from "../src/project-rs.ts";

const parsed = parseArgs({
  options: {
    version: { type: "string" },
    registry: { type: "string" },
    "pypi-publish-url": { type: "string" },
    "cargo-registry": { type: "string" },
  },
});

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return capture ? String(result.stdout).trim() : "";
}

function commandAvailable(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function rustHost(): string {
  const host = run("rustc", ["-vV"], true).match(/^host:\s+(.+)$/m)?.[1];
  if (!host) throw new Error("Unable to detect the local Rust target from rustc -vV");
  return host;
}

function pythonTag(): string {
  const value = run(
    "uv",
    [
      "run",
      "python",
      "-c",
      "import sysconfig; print(sysconfig.get_platform().replace('-', '_').replace('.', '_'))",
    ],
    true,
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

function publishCargo(config: RustWorkspaceMapping, registry: string): void {
  const manifests = config.crates
    .map((crate) => resolve(repoRoot, crate, "Cargo.toml"))
    .filter((manifest) => !/^publish = false$/m.test(readFileSync(manifest, "utf8")));
  const originals = new Map(
    manifests.map((manifest) => [manifest, readFileSync(manifest, "utf8")]),
  );
  try {
    const crateNames = manifests.map(
      (manifest) => readFileSync(manifest, "utf8").match(/^name = "([^"]+)"$/m)?.[1],
    );
    for (const manifest of manifests) {
      const mode = statSync(manifest).mode;
      let source = readFileSync(manifest, "utf8");
      for (const crateName of crateNames) {
        if (!crateName) continue;
        source = source.replace(
          new RegExp(
            `(${crateName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")} = \\{[^}]*)( \\})`,
            "g",
          ),
          `$1, registry = "${registry}"$2`,
        );
      }
      chmodSync(manifest, mode | 0o200);
      writeFileSync(manifest, source);
      chmodSync(manifest, mode);
    }
    for (const crateName of crateNames) {
      if (!crateName) continue;
      run("cargo", [
        "publish",
        "--package",
        crateName,
        "--registry",
        registry,
        "--allow-dirty",
        "--no-verify",
      ]);
    }
  } finally {
    for (const [manifest, source] of originals) {
      const mode = statSync(manifest).mode;
      chmodSync(manifest, mode | 0o200);
      writeFileSync(manifest, source);
      chmodSync(manifest, mode);
    }
  }
}

function buildAndPublish(binding: RustBindingMapping, version: string): void {
  const registry = parsed.values.registry;
  const pypiPublishUrl = parsed.values["pypi-publish-url"];
  const includeNode = Boolean(registry && binding.node && binding.nodePackage);
  const includePython = Boolean(pypiPublishUrl && binding.python && binding.pythonPackage);
  if (!includeNode && !includePython) return;

  const target = nativeTarget();
  const output = resolve(repoRoot, "dist/uniffi");
  run("bun", [
    resolve(dirname(fileURLToPath(import.meta.url)), "uniffi-release.ts"),
    "build",
    "--crate",
    binding.crate,
    "--rust",
    binding.rust,
    "--node",
    includeNode ? binding.node! : "",
    "--python",
    includePython ? binding.python! : "",
    "--node-package",
    includeNode ? binding.nodePackage! : "",
    "--python-package",
    includePython ? binding.pythonPackage! : "",
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
  ]);

  if (includeNode) {
    const packages = [
      ...artifacts(join(output, "npm"), ".tgz"),
      ...artifacts(join(output, "npm-facade"), ".tgz"),
    ];
    for (const packageFile of packages)
      run("npm", ["publish", packageFile, "--registry", registry!]);
  }
  if (includePython) {
    const wheels = artifacts(join(output, "python"), ".whl");
    if (wheels.length === 0) throw new Error(`No wheel produced for ${binding.crate}`);
    run("uvx", [
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

const version = parsed.values.version;
if (!version) throw new Error("Missing --version");
const config = rustConfig();
if (config?.bindings.length) {
  if (!commandAvailable("cargo") || !commandAvailable("rustc")) {
    throw new Error("Cargo and rustc are required because UniFFI Rust projects were detected");
  }
  for (const binding of config.bindings) buildAndPublish(binding, version);
}
const cargoRegistry = parsed.values["cargo-registry"];
if (cargoRegistry && config?.crates.length) {
  publishCargo(config, cargoRegistry);
}
