#!/usr/bin/env -S bun
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log, object } from "@dbx-tools/shared-core";
import { runTaskCommand, taskCommandSucceeds } from "../src/_task-command.ts";
import { readDbxToolsConfig, repoRoot } from "../src/packages.ts";
import {
  discoverRustCrates,
  hasUniFFIBindings,
  orderRustBindings,
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
  return taskCommandSucceeds(repoRoot, "cargo", ["--version"]);
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
  return { ...config, crates, bindings };
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
    ...(binding.python
      ? ["--python", binding.python, "--python-module", binding.pythonModule ?? ""]
      : []),
  ];
  runTaskCommand(repoRoot, process.execPath, [
    resolve(dirname(fileURLToPath(import.meta.url)), "uniffi.ts"),
    "--crate",
    binding.crate,
    ...targets,
  ]);
}

function* iterateAffectedRustBindings(
  bindings: readonly RustBindingMapping[],
  changed: ReadonlySet<string>,
): Generator<RustBindingMapping> {
  const affected = new Set(changed);
  for (const binding of orderRustBindings(bindings)) {
    if (binding.dependencies?.some((dependency) => affected.has(dependency))) {
      affected.add(binding.crate);
    }
    if (affected.has(binding.crate)) yield binding;
  }
}

export function affectedRustBindings(
  bindings: readonly RustBindingMapping[],
  changed: ReadonlySet<string>,
): RustBindingMapping[] {
  return [...iterateAffectedRustBindings(bindings, changed)];
}

/**
 * Lazily resolve direct binding owners so lock checks stop at the first match.
 */
export function changedRustOwners(
  config: RustWorkspaceMapping,
  changed: readonly string[],
): object.Sequence<RustBindingMapping> {
  return object
    .sequence(changed)
    .map((path) => ownerBinding(path, config.bindings))
    .nonNull()
    .distinct();
}

/** Collect direct owners, then lazily yield them and their dependents in order. */
export function changedRustBindings(
  config: RustWorkspaceMapping,
  changed: readonly string[],
): object.Sequence<RustBindingMapping> {
  const targets = new Set(changedRustOwners(config, changed).map((binding) => binding.crate));
  return object.sequence(iterateAffectedRustBindings(config.bindings, targets));
}

const config = rustConfig();

async function main(): Promise<void> {
  if (!config || config.crates.length === 0 || !existsSync(resolve(repoRoot, config.root))) return;
  if (!cargoAvailable()) {
    throw new Error("Cargo is required because Rust projects were detected");
  }
  if (!process.argv.includes("--watch")) {
    for (const binding of orderRustBindings(config.bindings)) generate(binding);
    return;
  }

  watchLoop(
    "rust",
    [resolve(repoRoot, config.root)],
    (changed) => {
      const latest = rustConfig() ?? config;
      if (rustStructureChanged(latest)) {
        logger.start("Rust project structure changed - re-synthesizing (+install)");
        runSynth({ post: true });
        logger.success("Rust project structure synchronized");
        const refreshed = rustConfig();
        if (!refreshed) return;
        for (const binding of changedRustBindings(refreshed, changed)) {
          logger.start(`generating ${binding.crate} bindings`);
          generate(binding);
          logger.success(`generated ${binding.crate} bindings`);
        }
        return;
      }
      for (const binding of changedRustBindings(latest, changed)) {
        logger.start(`generating ${binding.crate} bindings`);
        generate(binding);
        logger.success(`generated ${binding.crate} bindings`);
      }
    },
    {
      check: (changed) => {
        const latest = rustConfig() ?? config;
        return changedRustOwners(latest, changed).some(() => true) || rustStructureChanged(latest);
      },
    },
  );
}

if (import.meta.main) await main();
