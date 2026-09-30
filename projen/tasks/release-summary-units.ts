#!/usr/bin/env -S bun
/** Generate component-qualified release notes from an affected release plan. */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { generateReleaseSummary } from "./release-summary.ts";
import type { ReleaseUnitGraph } from "../src/release-catalog.ts";
import type { ReleasePlan } from "../src/release-plan.ts";

const logger = log.logger("projen:release-summary-units");

if (import.meta.main) {
  await new Command()
    .option("--root <path>", "repository root", ".")
    .option("--plan <path>", "affected release plan", "dist/release-plan.json")
    .option("--from-ref <ref>", "summary base ref", "origin/main")
    .option("--to-ref <ref>", "summary target ref", "HEAD")
    .action(async (options: { root: string; plan: string; fromRef: string; toRef: string }) => {
      const root = resolve(options.root);
      const plan = JSON.parse(readFileSync(resolve(root, options.plan), "utf8")) as ReleasePlan;
      const graph = JSON.parse(
        readFileSync(resolve(root, ".projen/release-units.json"), "utf8"),
      ) as ReleaseUnitGraph;
      const request = requestNotes(root);
      for (const planned of plan.units) {
        const unit = graph.units.find((candidate) => candidate.id === planned.id);
        if (!unit) throw new Error(`Release plan references unknown unit ${planned.id}`);
        const paths = graph.projects
          .filter((project) => project.unit === unit.id)
          .map((project) => project.path);
        const componentTag = `${planned.component}-v${planned.oldVersion}`;
        const fromRef = gitCapture(root, ["rev-parse", "--verify", componentTag])
          ? componentTag
          : options.fromRef;
        await generateReleaseSummary({
          root,
          component: planned.component,
          version: planned.newVersion,
          paths,
          customSummary: request.summary,
          outputFile: `.release-notes/final/${planned.component}-v${planned.newVersion}.md`,
          fromRef,
          toRef: options.toRef,
        });
      }
      for (const path of request.paths) rmSync(path);
      logger.success(`generated ${plan.units.length} component release summaries`);
    })
    .parseAsync();
}

function requestNotes(root: string): { summary?: string; paths: string[] } {
  const directory = resolve(root, ".release-notes/requests");
  if (!existsSync(directory)) return { paths: [] };
  const paths = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(directory, name));
  const summary = paths
    .map((path) =>
      readFileSync(path, "utf8")
        .replace(/^# .+\n+/, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
  return { ...(summary ? { summary } : {}), paths };
}

function gitCapture(root: string, args: string[]): string {
  const result = exec.spawnSync("git", args, {
    cwd: root,
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: false,
  });
  return result.exitCode === 0 ? (result.stdout?.trim() ?? "") : "";
}
