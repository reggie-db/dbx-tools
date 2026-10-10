#!/usr/bin/env -S bun
/** Verify that every committed package version matches the root VERSION file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { find } from "@dbx-tools/path";
import { json, log } from "@dbx-tools/shared-core";
import { parse } from "smol-toml";
import { runTaskMain } from "./cli.ts";
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

export function main(): void {
  const root = projectUtils.root() ?? process.cwd();
  const version = readWorkspaceVersion(root);
  const mismatches: string[] = [];
  const check = (name: string, actual: string | undefined): void => {
    if (actual !== version) mismatches.push(`${name}: ${actual ?? "missing"} != ${version}`);
  };

  check("package.json", manifestVersion(join(root, "package.json")));
  for (const pkg of recordedPackages(root)) {
    check(`${pkg.path}/package.json`, manifestVersion(join(pkg.dir, "package.json")));
  }

  for (const path of find.findFiles("**/pyproject.toml", { cwd: root })) {
    check(path, pythonVersion(join(root, path)));
  }
  if (mismatches.length > 0) {
    throw new Error(`Workspace version mismatch:\n${mismatches.join("\n")}`);
  }
  logger.success(`all workspace package versions match ${version}`);
}

await runTaskMain(import.meta, main);
