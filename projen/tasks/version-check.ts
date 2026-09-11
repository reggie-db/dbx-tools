#!/usr/bin/env -S bun
/** Verify that every committed package version matches the workspace VERSION. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec, project } from "@dbx-tools/core";
import { find } from "@dbx-tools/path";
import { json, log, object } from "@dbx-tools/shared-core";
import { parse } from "smol-toml";
import { recordedPackages } from "../src/packages.ts";
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

function cargoVersions(root: string): Array<{ name: string; version: string }> {
  if (!existsSync(join(root, "Cargo.toml"))) return [];
  const locked = existsSync(join(root, "Cargo.lock"));
  const result = exec.spawnSync(
    "cargo",
    ["metadata", ...(locked ? ["--locked"] : []), "--format-version", "1"],
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
      typeof candidate.version !== "string"
    ) {
      return [];
    }
    return [{ name: candidate.name, version: candidate.version }];
  });
}

function main(): void {
  const root = project.root() ?? process.cwd();
  const version = readWorkspaceVersion(root);
  const mismatches: string[] = [];
  const check = (name: string, actual: string | undefined): void => {
    if (actual !== version) mismatches.push(`${name}: ${actual ?? "missing"} != ${version}`);
  };

  check("package.json", manifestVersion(join(root, "package.json")));
  for (const pkg of recordedPackages(root)) {
    check(`${pkg.path}/package.json`, manifestVersion(join(pkg.dir, "package.json")));
    const barrel = join(pkg.dir, "index.ts");
    if (existsSync(barrel)) {
      const actual = /export const PACKAGE_VERSION = "([^"]+)";/.exec(
        readFileSync(barrel, "utf8"),
      )?.[1];
      check(`${pkg.path}/index.ts`, actual);
    }
  }

  for (const path of find.findFiles("**/pyproject.toml", { cwd: root })) {
    check(path, pythonVersion(join(root, path)));
  }
  for (const pkg of cargoVersions(root)) check(`Cargo package ${pkg.name}`, pkg.version);

  if (mismatches.length > 0) {
    throw new Error(`Workspace version mismatch:\n${mismatches.join("\n")}`);
  }
  logger.success(`all workspace versions match ${version}`);
}

main();
