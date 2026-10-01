#!/usr/bin/env -S bun
/** Bootstrap Release Please state from the generated release-unit graph. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { json, log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import type { ReleaseUnitGraph } from "../src/release-catalog.ts";

const logger = log.logger("projen:release-bootstrap");

function readGraph(root: string): ReleaseUnitGraph {
  const path = join(root, ".projen/release-units.json");
  const graph = json.parse(readFileSync(path, "utf8")) as ReleaseUnitGraph;
  if (graph.schemaVersion !== 1) {
    throw new Error(`Unsupported release-unit graph schema: ${String(graph.schemaVersion)}`);
  }
  return graph;
}

export function bootstrapReleaseUnits(root: string): void {
  const graph = readGraph(root);
  const manifestPath = join(root, ".release-please-manifest.json");
  const expected = Object.fromEntries(
    graph.units.map((unit) => [`.release-units/${unit.component}`, unit.version]),
  );
  if (existsSync(manifestPath)) {
    const current = json.parseRecord(readFileSync(manifestPath, "utf8"));
    for (const [path, version] of Object.entries(expected)) {
      if (current?.[path] !== version) {
        throw new Error(
          `Release Please manifest already contains ${path}=${String(current?.[path])}; expected ${version}`,
        );
      }
    }
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(expected, null, 2)}\n`);
  }

  for (const unit of graph.units) {
    const directory = join(root, ".release-units", unit.component);
    mkdirSync(directory, { recursive: true });
    const versionPath = join(directory, "version.txt");
    if (!existsSync(versionPath)) writeFileSync(versionPath, `${unit.version}\n`);
    const changelogPath = join(directory, "CHANGELOG.md");
    if (!existsSync(changelogPath)) writeFileSync(changelogPath, "# Changelog\n");
  }
  logger.success(`bootstrapped ${graph.units.length} release units`);
}

if (import.meta.main) {
  new Command()
    .option("--root <path>", "repository root")
    .action((options: { root?: string }) => {
      bootstrapReleaseUnits(resolve(options.root ?? projectUtils.root() ?? process.cwd()));
    })
    .parse();
}
