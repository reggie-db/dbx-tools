#!/usr/bin/env -S bun
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log } from "@dbx-tools/shared-core";
import { readDbxToolsConfig, repoRoot } from "../src/packages.ts";
import {
  discoverRustCrates,
  hasUniFFIBindings,
  type RustBindingMapping,
  type RustWorkspaceMapping,
} from "../src/project-rs.ts";
import { runSynth } from "../src/scaffold.ts";
import { watchLoop } from "../src/watch.ts";

const logger = log.logger("projen:rust");

function rustConfig(): RustWorkspaceMapping | undefined {
  const value = readDbxToolsConfig(repoRoot)?.rust;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<RustWorkspaceMapping>;
  if (typeof candidate.root !== "string") return undefined;
  if (!Array.isArray(candidate.crates) || !Array.isArray(candidate.bindings)) return undefined;
  return candidate as RustWorkspaceMapping;
}

function cargoAvailable(): boolean {
  return spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;
}

function currentStructure(config: RustWorkspaceMapping): RustWorkspaceMapping {
  const root = resolve(repoRoot, config.root);
  const directories = discoverRustCrates(root);
  const crates = directories.map((directory) => `${config.root}/${directory}`);
  const recorded = new Map(config.bindings.map((binding) => [binding.rust, binding]));
  const bindings = crates.flatMap((rust) => {
    if (!hasUniFFIBindings(resolve(repoRoot, rust))) return [];
    const binding = recorded.get(rust);
    return binding ? [binding] : [{ crate: "", rust }];
  });
  return { root: config.root, crates, bindings };
}

/** Whether discovered crate membership or UniFFI marker membership changed. */
export function rustStructureChanged(config: RustWorkspaceMapping): boolean {
  return !sameStructure(config, currentStructure(config));
}

function sameStructure(left: RustWorkspaceMapping, right: RustWorkspaceMapping): boolean {
  return (
    JSON.stringify(left.crates) === JSON.stringify(right.crates) &&
    JSON.stringify(left.bindings.map((binding) => binding.rust)) ===
      JSON.stringify(right.bindings.map((binding) => binding.rust))
  );
}

function ownerBinding(
  path: string,
  bindings: readonly RustBindingMapping[],
): RustBindingMapping | undefined {
  const absolute = isAbsolute(path) ? path : resolve(repoRoot, path);
  return bindings.find((binding) => {
    const directory = resolve(repoRoot, binding.rust);
    return absolute === directory || absolute.startsWith(directory + sep);
  });
}

function generate(binding: RustBindingMapping): void {
  const targets = [
    ...(binding.node ? ["--node", binding.node] : []),
    ...(binding.python ? ["--python", binding.python] : []),
  ];
  const result = spawnSync(
    process.execPath,
    [
      resolve(dirname(fileURLToPath(import.meta.url)), "uniffi.ts"),
      "--crate",
      binding.crate,
      ...targets,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`binding generation exited with ${result.status}`);
}

const config = rustConfig();

async function main(): Promise<void> {
  if (!config || config.crates.length === 0 || !existsSync(resolve(repoRoot, config.root))) return;
  if (!cargoAvailable()) {
    throw new Error("Cargo is required because Rust projects were detected");
  }
  if (!process.argv.includes("--watch")) {
    for (const binding of config.bindings) generate(binding);
    return;
  }

  watchLoop("rust", [resolve(repoRoot, config.root)], (changed) => {
    const latest = rustConfig() ?? config;
    if (rustStructureChanged(latest)) {
      logger.start("Rust project structure changed - re-synthesizing (+install)");
      runSynth({ post: true });
      logger.success("Rust project structure synchronized");
      const refreshed = rustConfig();
      if (!refreshed) return;
      const targets = new Map<string, RustBindingMapping>();
      for (const path of changed) {
        const binding = ownerBinding(path, refreshed.bindings);
        if (binding) targets.set(binding.crate, binding);
      }
      for (const binding of targets.values()) {
        logger.start(`generating ${binding.crate} bindings`);
        generate(binding);
        logger.success(`generated ${binding.crate} bindings`);
      }
      return;
    }
    const targets = new Map<string, RustBindingMapping>();
    for (const path of changed) {
      const binding = ownerBinding(path, latest.bindings);
      if (binding) targets.set(binding.crate, binding);
    }
    for (const binding of targets.values()) {
      logger.start(`generating ${binding.crate} bindings`);
      generate(binding);
      logger.success(`generated ${binding.crate} bindings`);
    }
  });
}

if (import.meta.main) await main();
