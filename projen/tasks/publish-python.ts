#!/usr/bin/env -S bun
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { Command } from "commander";
import { parse, stringify } from "smol-toml";
import { pythonProjectInfo, stampPythonProject } from "./uniffi-python.js";
import type { ReleasePlan } from "../src/release-plan.ts";

interface PythonProjectFile {
  readonly directory: string;
  readonly mode: number;
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly private: boolean;
  readonly source: string;
  readonly uniffi: boolean;
}

export interface StampPythonProjectsOptions {
  readonly rewriteDependencies?: boolean;
  readonly versions?: ReadonlyMap<string, string>;
}

export interface RestorePythonProjects {
  (): void;
  readonly paths: readonly string[];
}

export function stampPythonProjects(
  root: string,
  version: string,
  options: StampPythonProjectsOptions = {},
): RestorePythonProjects {
  const packageFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name, "pyproject.toml"))
    .filter(existsSync)
    .sort();
  const allProjects: PythonProjectFile[] = packageFiles.map((path) => {
    const source = readFileSync(path, "utf8");
    const info = pythonProjectInfo(source, { parse, stringify });
    return {
      directory: basename(resolve(path, "..")),
      mode: statSync(path).mode,
      name: info.name,
      version: info.version,
      path,
      private: info.private,
      source,
      uniffi: info.uniffi,
    };
  });
  const projects = allProjects.filter(
    (project) => !project.private && (!options.versions || options.versions.has(project.directory)),
  );
  if (projects.length === 0) throw new Error(`No Python packages found under ${root}`);

  try {
    for (const project of projects) {
      const stamped = stampPythonProject(project.source, {
        packages: allProjects,
        rewriteDependencies: options.rewriteDependencies,
        usePackageVersions: options.versions !== undefined,
        toml: { parse, stringify },
        version: options.versions?.get(project.directory) ?? version,
      });
      chmodSync(project.path, project.mode | 0o200);
      writeFileSync(project.path, stamped);
      chmodSync(project.path, project.mode);
    }
  } catch (error) {
    for (const project of projects) {
      chmodSync(project.path, project.mode | 0o200);
      writeFileSync(project.path, project.source);
      chmodSync(project.path, project.mode);
    }
    throw error;
  }

  const restore = () => {
    for (const project of projects) {
      chmodSync(project.path, project.mode | 0o200);
      writeFileSync(project.path, project.source);
      chmodSync(project.path, project.mode);
    }
  };
  Object.defineProperty(restore, "paths", {
    value: projects.map((project) => project.path),
  });
  return restore as RestorePythonProjects;
}

export function publishPythonProjects(options: {
  readonly dryRun?: boolean;
  readonly indexUrl: string;
  readonly publishUrl: string;
  readonly root: string;
  readonly version: string;
  readonly plan?: ReleasePlan;
}): void {
  const root = resolve(options.root);
  const output = mkdtempSync(join(tmpdir(), "dbx-tools-python-publish-"));
  const planned = new Map(
    options.plan?.pythonPackages.map((pkg) => [pkg.path.replace(/^.*\//, ""), pkg.version]) ?? [],
  );
  const stamp = stampPythonProjects(root, options.version, {
    ...(options.plan ? { versions: planned } : {}),
  });
  try {
    const packages = options.plan?.pythonPackages ?? [];
    if (packages.length > 0) {
      for (const pkg of packages) {
        exec.spawnSync("uv", ["build", "--package", pkg.identity, "--out-dir", output], {
          cwd: process.cwd(),
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
        });
      }
    } else {
      exec.spawnSync("uv", ["build", "--all-packages", "--out-dir", output], {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      });
    }
    exec.spawnSync(
      "uvx",
      [
        "--from",
        "devpi-client",
        "devpi",
        "upload",
        "--index",
        options.publishUrl,
        "--from-dir",
        ...(options.dryRun ? ["--dry-run"] : []),
        output,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, UV_DEFAULT_INDEX: options.indexUrl },
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      },
    );
  } finally {
    stamp();
    rmSync(output, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const program = new Command();
  program
    .argument("[version]", "Python package version")
    .requiredOption("--index-url <url>", "devpi Simple API URL")
    .requiredOption("--publish-url <url>", "devpi writable index URL")
    .option("--root <path>", "Python workspace package root", "packages/py")
    .option("--plan <path>", "affected release plan")
    .option("--dry-run", "build and inspect distributions without uploading")
    .action(
      (
        version: string | undefined,
        options: {
          dryRun?: boolean;
          indexUrl: string;
          publishUrl: string;
          root: string;
          plan?: string;
        },
      ) => {
        const plan = options.plan
          ? (JSON.parse(readFileSync(options.plan, "utf8")) as ReleasePlan)
          : undefined;
        const fallbackVersion = version ?? plan?.pythonPackages[0]?.version;
        if (!fallbackVersion) throw new Error("Python publication requires a version or plan");
        publishPythonProjects({ ...options, version: fallbackVersion, plan });
      },
    );
  await program.parseAsync();
}
