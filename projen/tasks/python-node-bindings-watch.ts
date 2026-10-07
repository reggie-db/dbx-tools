#!/usr/bin/env -S bun
/** Keep every configured Python Node bridge current with one repository watcher. */
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@dbx-tools/shared-core";
import { runTaskCommand } from "../src/_task-command.ts";
import { repoRoot } from "../src/packages.ts";
import {
  affectedPythonNodeBindingProjects,
  generatePythonNodeBindings,
  pythonNodeBindingWatchInputs,
  resolveAllPythonNodeBindings,
  type ResolvedPythonNodeBindings,
} from "../src/python-node-bindings.ts";
import { watchLoop, watchRoots } from "../src/watch.ts";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";

const logger = log.logger("projen:python-node-bindings-watch");
const generator = fileURLToPath(new URL("./python-node-bindings.ts", import.meta.url));

function generate(project: string): void {
  runTaskCommand(repoRoot, "bun", [generator, "--root", repoRoot, "--project", project]);
}

function containsPath(parent: string, candidate: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${sep}`)
  );
}

/**
 * Watch broad package roots, each configured Python workspace root, and only
 * exceptional inputs such as function overrides that live outside those roots.
 */
function watchPaths(configs: readonly ResolvedPythonNodeBindings[]): string[] {
  const roots = watchRoots();
  const pythonRoots = configs.map(({ projectDirectory }) => dirname(projectDirectory));
  const covered = [...roots, ...pythonRoots];
  const explicitInputs = configs
    .flatMap(pythonNodeBindingWatchInputs)
    .filter((input) => !covered.some((root) => containsPath(root, input)));
  return [...new Set([...covered, ...explicitInputs])].sort();
}

function selection(
  previous: readonly ResolvedPythonNodeBindings[],
  changed: readonly string[],
): {
  readonly all: boolean;
  readonly configs: ResolvedPythonNodeBindings[];
  readonly projects: string[];
} {
  const configs = resolveAllPythonNodeBindings(repoRoot);
  const manifests = new Set([...previous, ...configs].map(({ pyproject }) => resolve(pyproject)));
  const all = changed.some((path) => manifests.has(resolve(path)));
  return {
    all,
    configs,
    projects: all ? [] : affectedPythonNodeBindingProjects(repoRoot, configs, changed),
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
        return;
      }
      for (const project of next.projects) {
        generate(project);
        logger.success(`regenerated ${project} Node bindings`);
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

if (import.meta.main) await main();
