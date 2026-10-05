#!/usr/bin/env -S bun
/** Compile source-first workspace packages in a few TypeScript processes. */
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import * as exec from "@dbx-tools/core/exec";

interface PackageManifest {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly workspaces?: string[];
}

interface TaskManifest {
  readonly tasks?: {
    readonly compile?: {
      readonly steps?: Array<{ readonly execArgs?: string[] }>;
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
    const steps = existsSync(taskPath)
      ? readJson<TaskManifest>(taskPath).tasks?.compile?.steps
      : undefined;
    if (
      script === "projen compile" &&
      !manifest.scripts?.precompile &&
      !manifest.scripts?.postcompile &&
      plainTypeScriptBuild(steps)
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
    console.log(
      `Type-checking ${plan.typescriptConfigs.length} workspaces in ${batchCount} batches`,
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
      result: exec.spawn("bun", ["run", "compile"], {
        cwd: pkg.directory,
        stdin: "ignore",
        stdout: (line) => console.log(`${pkg.name}: ${line.replace(emoji, "")}`),
        stderr: (line) => console.error(`${pkg.name}: ${line.replace(emoji, "")}`),
      }),
    });
  }
  const results = await Promise.allSettled(jobs.map((job) => job.result));
  let failed = false;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`${jobs[index]!.name} compile failed:`, result.reason);
      failed = true;
    } else if (result.value.exitCode !== 0) {
      console.error(`${jobs[index]!.name} compile exited with ${result.value.exitCode}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}
