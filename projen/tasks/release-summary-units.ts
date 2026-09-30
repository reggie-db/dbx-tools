#!/usr/bin/env -S bun
/** Generate component-qualified release notes from an affected release plan. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
      for (const planned of plan.units) {
        const unit = graph.units.find((candidate) => candidate.id === planned.id);
        if (!unit) throw new Error(`Release plan references unknown unit ${planned.id}`);
        const paths = graph.projects
          .filter((project) => project.unit === unit.id)
          .map((project) => project.path);
        await generateReleaseSummary({
          root,
          component: planned.component,
          version: planned.newVersion,
          paths,
          fromRef: options.fromRef,
          toRef: options.toRef,
        });
      }
      logger.success(`generated ${plan.units.length} component release summaries`);
    })
    .parseAsync();
}
