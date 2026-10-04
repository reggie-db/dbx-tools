#!/usr/bin/env -S bun
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log } from "@dbx-tools/shared-core";
import { runTaskCommand } from "../src/_task-command.ts";
import { pythonNodeBindingProjects, repoRoot } from "../src/packages.ts";
import {
  pythonNodeBindingWatchInputs,
  resolvePythonNodeBindings,
  type ResolvedPythonNodeBindings,
} from "../src/python-node-bindings.ts";
import { watchLoop } from "../src/watch.ts";

const logger = log.logger("projen:python-node-bindings");
const task = resolve(dirname(fileURLToPath(import.meta.url)), "python-node-bindings.ts");
const { values } = parseArgs({ options: { project: { type: "string" } } });
const projects = values.project ? [values.project] : pythonNodeBindingProjects(repoRoot);
const configs = projects.map((project) => resolvePythonNodeBindings(repoRoot, project));

if (configs.length > 0) {
  watchLoop(
    "python-node-bindings",
    [...new Set(configs.flatMap(pythonNodeBindingWatchInputs))],
    (changed) => {
      for (const config of configs.filter((candidate) => affected(candidate, changed))) {
        logger.start(`generating ${config.project} Node bindings`);
        runTaskCommand(repoRoot, "bun", [task, "--project", config.project]);
        logger.success(`generated ${config.project} Node bindings`);
      }
    },
    {
      check: (changed) => configs.some((config) => affected(config, changed)),
    },
  );
}

function affected(config: ResolvedPythonNodeBindings, changed: readonly string[]): boolean {
  const inputs = pythonNodeBindingWatchInputs(config);
  return changed.some((path) => inputs.some((input) => contains(input, path)));
}

function contains(input: string, candidate: string): boolean {
  const root = isAbsolute(input) ? input : resolve(repoRoot, input);
  const path = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate);
  return path === root || path.startsWith(root + sep);
}
