#!/usr/bin/env -S bun
/** Batch package type-checks and run package-owned compile lifecycles. */
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import * as exec from "@dbx-tools/core/exec";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("projen:compile");

interface PackageManifest {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly workspaces?: string[];
}

interface TaskManifest {
  readonly tasks?: {
    readonly "pre-compile"?: {
      readonly steps?: Array<{ readonly exec?: string; readonly execArgs?: string[] }>;
    };
    readonly compile?: {
      readonly steps?: Array<{ readonly exec?: string; readonly execArgs?: string[] }>;
    };
    readonly "post-compile"?: {
      readonly steps?: Array<{ readonly exec?: string; readonly execArgs?: string[] }>;
    };
  };
}

export interface CompilePlan {
  readonly typescriptConfigs: string[];
  readonly customPackages: Array<{ readonly name: string; readonly directory: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function plainTypeScriptBuild(steps: unknown): boolean {
  if (!Array.isArray(steps) || steps.length !== 1) return false;
  const step = steps[0] as { execArgs?: string[] };
  if (!step || typeof step !== "object") return false;
  return (
    Object.keys(step).length === 1 &&
    step.execArgs?.length === 2 &&
    step.execArgs[0] === "tsc" &&
    step.execArgs[1] === "--build"
  );
}

function hasSteps(steps: unknown): boolean {
  return Array.isArray(steps) && steps.length > 0;
}

/** Read the root's concrete workspace paths on every run, including newly added members. */
export function compilePlan(root: string): CompilePlan {
  const workspace = readJson<PackageManifest>(join(root, "package.json"));
  const typescriptConfigs: string[] = [];
  const customPackages: CompilePlan["customPackages"] = [];
  for (const member of workspace.workspaces ?? []) {
    const directory = resolve(root, member);
    const manifest = readJson<PackageManifest>(join(directory, "package.json"));
    const script = manifest.scripts?.compile;
    if (!script) continue;
    const taskPath = join(directory, ".projen", "tasks.json");
    const tasks = existsSync(taskPath) ? readJson<TaskManifest>(taskPath).tasks : undefined;
    const plainCompile = plainTypeScriptBuild(tasks?.compile?.steps);
    if (
      script === "projen compile" &&
      plainCompile &&
      !hasSteps(tasks?.["pre-compile"]?.steps) &&
      !hasSteps(tasks?.["post-compile"]?.steps)
    ) {
      typescriptConfigs.push(join(directory, "tsconfig.json"));
    } else {
      customPackages.push({ name: manifest.name ?? member, directory });
    }
  }
  return { typescriptConfigs, customPackages };
}

const emoji = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

export async function main(): Promise<void> {
  const root = process.cwd();
  const plan = compilePlan(root);
  const jobs: Array<{ name: string; result: Promise<exec.ExecResult> }> = [];
  if (plan.typescriptConfigs.length > 0) {
    const batchCount = Math.min(4, availableParallelism(), plan.typescriptConfigs.length);
    const batches = Array.from({ length: batchCount }, () => [] as string[]);
    plan.typescriptConfigs.forEach((config, index) => batches[index % batchCount]!.push(config));
    logger.info(
      `type-checking ${plan.typescriptConfigs.length} workspaces in ${batchCount} batches`,
    );
    for (const [index, batch] of batches.entries()) {
      jobs.push({
        name: `TypeScript batch ${index + 1}`,
        result: exec.spawn("bunx", ["tsc", "--build", ...batch], {
          cwd: root,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      });
    }
  }
  for (const pkg of plan.customPackages) {
    jobs.push({
      name: pkg.name,
      result: compileCustomPackage(pkg),
    });
  }
  const results = await Promise.allSettled(jobs.map((job) => job.result));
  let failed = false;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.error(`${jobs[index]!.name} compile failed:`, result.reason);
      failed = true;
    } else if (result.value.exitCode !== 0) {
      logger.error(`${jobs[index]!.name} compile exited with ${result.value.exitCode}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

async function compileCustomPackage(pkg: {
  readonly name: string;
  readonly directory: string;
}): Promise<exec.ExecResult> {
  let result: exec.ExecResult | undefined;
  for (const task of ["pre-compile", "compile", "post-compile"]) {
    result = await exec.spawn("bun", ["run", task], {
      cwd: pkg.directory,
      stdin: "ignore",
      stdout: (line) => logger.info(`${pkg.name}: ${line.replace(emoji, "")}`),
      stderr: (line) => logger.error(`${pkg.name}: ${line.replace(emoji, "")}`),
    });
    if (result.exitCode !== 0) return result;
  }
  return result!;
}

if (import.meta.main) await main();
