#!/usr/bin/env -S bun
/** Verify that every committed package version matches its owning release unit. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { exec, projectUtils } from "@dbx-tools/core";
import { find } from "@dbx-tools/path";
import { json, log, object } from "@dbx-tools/shared-core";
import { parse } from "smol-toml";
import { recordedPackages, toPosix } from "../src/packages.ts";
import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import { readWorkspaceVersion } from "../src/workspace-version.ts";

const logger = log.logger("projen:version-check");

function manifestVersion(path: string): string | undefined {
  const manifest = json.parseRecord(readFileSync(path, "utf8"));
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

function pythonVersion(path: string): string | undefined {
  const manifest = parse(readFileSync(path, "utf8")) as {
    project?: { version?: unknown };
  };
  return typeof manifest.project?.version === "string" ? manifest.project.version : undefined;
}

function cargoVersions(root: string): Array<{ name: string; version: string; path: string }> {
  if (!existsSync(join(root, "Cargo.toml"))) return [];
  const locked = existsSync(join(root, "Cargo.lock"));
  const result = exec.spawnSync(
    "cargo",
    ["metadata", ...(locked ? ["--locked"] : []), "--format-version", "1", "--no-deps"],
    {
      cwd: root,
      stdout: "capture",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    },
  );
  const metadata = json.parseRecord(result.stdout ?? "");
  if (!Array.isArray(metadata?.packages)) return [];
  return metadata.packages.flatMap((candidate) => {
    if (
      !object.isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      typeof candidate.version !== "string" ||
      typeof candidate.manifest_path !== "string"
    ) {
      return [];
    }
    return [
      {
        name: candidate.name,
        version: candidate.version,
        path: toPosix(relative(root, dirname(candidate.manifest_path))) || ".",
      },
    ];
  });
}

function main(): void {
  const root = projectUtils.root() ?? process.cwd();
  const fixedVersion = readWorkspaceVersion(root);
  const graphPath = join(root, ".projen/release-units.json");
  const graph = existsSync(graphPath)
    ? (JSON.parse(readFileSync(graphPath, "utf8")) as ReleaseUnitGraph)
    : undefined;
  const units = new Map(graph?.units.map((unit) => [unit.id, unit.version]) ?? []);
  const projects = new Map(graph?.projects.map((entry) => [entry.path, entry]) ?? []);
  const mismatches: string[] = [];
  const expected = (path: string): string | undefined => {
    const releaseProject = projects.get(path);
    if (releaseProject?.unit) return units.get(releaseProject.unit);
    return graph?.mode === "independent" ? undefined : fixedVersion;
  };
  const check = (name: string, path: string, actual: string | undefined): void => {
    const version = expected(path);
    if (version !== undefined && actual !== version) {
      mismatches.push(`${name}: ${actual ?? "missing"} != ${version}`);
    }
  };

  check("package.json", ".", manifestVersion(join(root, "package.json")));
  for (const pkg of recordedPackages(root)) {
    check(`${pkg.path}/package.json`, pkg.path, manifestVersion(join(pkg.dir, "package.json")));
    const barrel = join(pkg.dir, "index.ts");
    if (existsSync(barrel)) {
      const actual = /export const PACKAGE_VERSION = "([^"]+)";/.exec(
        readFileSync(barrel, "utf8"),
      )?.[1];
      check(`${pkg.path}/index.ts`, pkg.path, actual);
    }
  }

  for (const path of find.findFiles("**/pyproject.toml", { cwd: root })) {
    check(path, toPosix(dirname(path)), pythonVersion(join(root, path)));
  }
  for (const pkg of cargoVersions(root)) {
    check(`Cargo package ${pkg.name}`, pkg.path, pkg.version);
  }

  if (mismatches.length > 0) {
    throw new Error(`Release-unit version mismatch:\n${mismatches.join("\n")}`);
  }
  logger.success(
    graph
      ? `all package versions match ${graph.units.length} release units`
      : `all workspace versions match ${fixedVersion}`,
  );
}

main();
