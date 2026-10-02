#!/usr/bin/env -S bun
/** Build exact Cargo archives and the metadata needed by a static sparse index. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as exec from "@dbx-tools/core/exec";
import { Command } from "commander";

export interface CargoDependency {
  readonly features: string[];
  readonly kind: "build" | "dev" | null;
  readonly name: string;
  readonly optional: boolean;
  readonly registry: string | null;
  readonly rename: string | null;
  readonly req: string;
  readonly source: string | null;
  readonly target: string | null;
  readonly uses_default_features: boolean;
}

interface CargoPackage {
  readonly dependencies: CargoDependency[];
  readonly features: Record<string, string[]>;
  readonly links: string | null;
  readonly name: string;
  readonly rust_version: string | null;
  readonly version: string;
}

interface CargoMetadata {
  readonly packages: CargoPackage[];
  readonly target_directory: string;
}

export interface CargoIndexDependency {
  readonly default_features: boolean;
  readonly features: readonly string[];
  readonly kind: "build" | "dev" | "normal";
  readonly name: string;
  readonly optional: boolean;
  readonly package?: string;
  readonly registry: "self" | string | null;
  readonly req: string;
  readonly target: string | null;
}

export interface CargoIndexRecord {
  readonly cksum: string;
  readonly deps: readonly CargoIndexDependency[];
  readonly features: Record<string, never>;
  readonly features2: Readonly<Record<string, readonly string[]>>;
  readonly links?: string;
  readonly name: string;
  readonly rust_version?: string;
  readonly v: 2;
  readonly vers: string;
  readonly yanked: false;
}

export interface CargoIndexPackage {
  readonly asset: string;
  readonly record: CargoIndexRecord;
}

export interface CargoIndexManifest {
  readonly packages: readonly CargoIndexPackage[];
  readonly schemaVersion: 1;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Translate Cargo metadata dependency ownership into sparse-index semantics. */
export function cargoIndexDependency(
  dependency: CargoDependency,
  internalCrates: ReadonlySet<string>,
): CargoIndexDependency {
  return {
    name: dependency.rename ?? dependency.name,
    req: dependency.req,
    features: dependency.features,
    optional: dependency.optional,
    default_features: dependency.uses_default_features,
    target: dependency.target,
    kind: dependency.kind ?? "normal",
    registry:
      internalCrates.has(dependency.name) && dependency.source === null
        ? "self"
        : (dependency.source?.replace(/^registry\+/, "") ?? dependency.registry),
    ...(dependency.rename ? { package: dependency.name } : {}),
  };
}

/** Package selected crates and write one release-local sparse-index manifest. */
export function packageCargoCrates(options: {
  readonly crates: readonly string[];
  readonly output: string;
  readonly root: string;
}): CargoIndexManifest {
  const root = resolve(options.root);
  const output = resolve(options.output);
  const metadataResult = exec.spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    {
      cwd: root,
      stdout: "capture",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    },
  );
  const metadata = JSON.parse(metadataResult.stdout) as CargoMetadata;
  const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]));
  const internalCrates = new Set(options.crates);
  const archives = join(output, "crates");
  mkdirSync(archives, { recursive: true });

  const packaged = options.crates.map<CargoIndexPackage>((name) => {
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`Cargo metadata does not contain ${name}`);
    exec.spawnSync(
      "cargo",
      [
        "package",
        "--package",
        name,
        "--no-verify",
        ...(existsSync(join(root, "Cargo.lock")) ? ["--locked"] : []),
      ],
      {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      },
    );
    const asset = `${pkg.name}-${pkg.version}.crate`;
    const source = join(metadata.target_directory, "package", asset);
    const destination = join(archives, asset);
    copyFileSync(source, destination);
    return {
      asset,
      record: {
        name: pkg.name,
        vers: pkg.version,
        deps: pkg.dependencies.map((dependency) =>
          cargoIndexDependency(dependency, internalCrates),
        ),
        cksum: sha256(destination),
        features: {},
        features2: pkg.features,
        yanked: false,
        ...(pkg.links ? { links: pkg.links } : {}),
        ...(pkg.rust_version ? { rust_version: pkg.rust_version } : {}),
        v: 2,
      },
    };
  });
  const manifest: CargoIndexManifest = {
    schemaVersion: 1,
    packages: packaged,
  };
  writeFileSync(join(output, "cargo-index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  const program = new Command();
  program
    .requiredOption(
      "--crate <name>",
      "Cargo crate to package",
      (name: string, names: string[]) => [...names, name],
      [],
    )
    .option("--output <path>", "Distribution output directory", "dist/cargo")
    .option("--root <path>", "Cargo workspace root", ".")
    .action((options: { crate: string[]; output: string; root: string }) => {
      packageCargoCrates({
        crates: options.crate,
        output: options.output,
        root: options.root,
      });
    });
  await program.parseAsync();
}
