#!/usr/bin/env -S bun
/** Keep every configured Python Node bridge current with one repository watcher. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@dbx-tools/shared-core";
import { runTaskMain } from "./cli.ts";
import { runTaskCommand } from "../src/_task-command.ts";
import { repoRoot } from "../src/packages.ts";
import {
  affectedPythonNodeBindingProjects,
  generatePythonNodeBindings,
  pythonNodeBindingWatchInputs,
  resolveAllPythonNodeBindings,
  type ResolvedPythonNodeBindings,
} from "../src/python-node-bindings.ts";
import { watchLoop } from "../src/watch.ts";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";

const logger = log.logger("projen:python-node-bindings-watch");
const generator = fileURLToPath(new URL("./python-node-bindings.ts", import.meta.url));
const watcher = fileURLToPath(import.meta.url);
const bindingSource = fileURLToPath(new URL("../src/python-node-bindings.ts", import.meta.url));
const toolingInputs = [generator, watcher, bindingSource];

function generate(project: string): void {
  runTaskCommand(repoRoot, "bun", [generator, "--root", repoRoot, "--project", project]);
}

/**
 * Watch only configured manifests and transitive workspace source inputs.
 */
function watchPaths(configs: readonly ResolvedPythonNodeBindings[]): string[] {
  return [...new Set([...configs.flatMap(pythonNodeBindingWatchInputs), ...toolingInputs])].sort();
}

function selection(
  previous: readonly ResolvedPythonNodeBindings[],
  changed: readonly string[],
): {
  readonly all: boolean;
  readonly configs: ResolvedPythonNodeBindings[];
  readonly projects: string[];
  readonly restart: boolean;
} {
  const configs = resolveAllPythonNodeBindings(repoRoot);
  const manifests = new Set([...previous, ...configs].map(({ pyproject }) => resolve(pyproject)));
  const all = changed.some(
    (path) =>
      manifests.has(resolve(path)) ||
      toolingInputs.some((input) => resolve(input) === resolve(path)),
  );
  return {
    all,
    configs,
    projects: all ? [] : affectedPythonNodeBindingProjects(repoRoot, configs, changed),
    restart: watchPaths(previous).join("\n") !== watchPaths(configs).join("\n"),
  };
}

/** Generate once, then rebuild only bridges affected by each debounced change batch. */
export async function main(): Promise<void> {
  let configs = resolveAllPythonNodeBindings(repoRoot);
  await withWorkspaceMutationLock(repoRoot, () => generatePythonNodeBindings(repoRoot));
  logger.success("generated all Python Node bindings");

  watchLoop(
    "python-node-bindings",
    watchPaths(configs),
    (changed) => {
      const next = selection(configs, changed);
      configs = next.configs;
      if (next.all) {
        generatePythonNodeBindings(repoRoot);
        logger.success("regenerated all Python Node bindings");
      } else {
        for (const project of next.projects) {
          generate(project);
          logger.success(`regenerated ${project} Node bindings`);
        }
      }
      if (next.restart) {
        logger.info("binding inputs changed; restarting watcher");
        setTimeout(() => process.exit(0), 0);
      }
    },
    {
      check: (changed) => {
        const next = selection(configs, changed);
        return next.all || next.projects.length > 0;
      },
    },
  );
}

await runTaskMain(import.meta, main);
