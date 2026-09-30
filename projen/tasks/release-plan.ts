#!/usr/bin/env -S bun
/** Build the affected release plan for the reviewed manifest change. */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { json, log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import { buildRecoveryReleasePlan, buildReleasePlan } from "../src/release-plan.ts";

const logger = log.logger("projen:release-plan");

function graphAtRef(root: string, ref: string): ReleaseUnitGraph | undefined {
  const result = exec.spawnSync("git", ["show", `${ref}:.projen/release-units.json`], {
    cwd: root,
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: false,
  });
  if (result.exitCode !== 0 || !result.stdout) return undefined;
  return json.parse(result.stdout) as ReleaseUnitGraph;
}

function writeOutput(name: string, value: unknown): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    appendFileSync(output, `${name}=${rendered}\n`);
  }
}

new Command()
  .option("--root <path>", "repository root", ".")
  .option("--base-ref <ref>", "previous release graph ref", "HEAD^")
  .option("--component <component>", "component to recover")
  .option("--version <version>", "component version to recover")
  .option("--docs", "include documentation without a package release")
  .option("--output <path>", "release plan output", "dist/release-plan.json")
  .action(
    (options: {
      root: string;
      baseRef: string;
      output: string;
      component?: string;
      version?: string;
      docs?: boolean;
    }) => {
      const root = resolve(options.root);
      const current = json.parse(
        readFileSync(resolve(root, ".projen/release-units.json"), "utf8"),
      ) as ReleaseUnitGraph;
      if (Boolean(options.component) !== Boolean(options.version)) {
        throw new Error("Recovery requires both --component and --version");
      }
      const planned =
        options.component && options.version
          ? buildRecoveryReleasePlan(current, options.component, options.version)
          : buildReleasePlan(current, graphAtRef(root, options.baseRef));
      const plan = options.docs
        ? {
            ...planned,
            stages: { ...planned.stages, docs: true },
            omittedStages: planned.omittedStages.filter((stage) => stage !== "docs"),
          }
        : planned;
      const output = resolve(root, options.output);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
      writeOutput("plan", plan);
      writeOutput("release_sha", process.env.GITHUB_SHA ?? "");
      writeOutput("units", plan.units);
      writeOutput("node_packages", plan.nodePackages);
      writeOutput("python_packages", plan.pythonPackages);
      writeOutput("rust_packages", plan.rustPackages);
      writeOutput("artifacts", plan.artifacts);
      writeOutput("rust_targets", plan.rustTargets);
      writeOutput("stages", plan.stages);
      for (const [stage, enabled] of Object.entries(plan.stages)) {
        writeOutput(stage, enabled);
      }
      logger.success("release plan generated", {
        units: plan.units.length,
        omittedStages: plan.omittedStages,
      });
    },
  )
  .parse();
