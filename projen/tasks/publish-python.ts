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

interface PythonProjectFile {
  readonly directory: string;
  readonly mode: number;
  readonly name: string;
  readonly path: string;
  readonly source: string;
}

export interface StampPythonProjectsOptions {
  readonly rewriteDependencies?: boolean;
}

export interface RestorePythonProjects {
  (): void;
  readonly paths: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const projects: PythonProjectFile[] = packageFiles.map((path) => {
    const source = readFileSync(path, "utf8");
    const name = /^name = "([^"]+)"$/m.exec(source)?.[1];
    if (!name) throw new Error(`Missing project name in ${path}`);
    return {
      directory: basename(resolve(path, "..")),
      mode: statSync(path).mode,
      name,
      path,
      source,
    };
  });
  if (projects.length === 0) throw new Error(`No Python packages found under ${root}`);

  try {
    for (const project of projects) {
      const versionPattern = /^version = "[^"]+"$/m;
      if (!versionPattern.test(project.source)) {
        throw new Error(`Expected one project version in ${project.path}`);
      }
      let stamped = project.source.replace(versionPattern, `version = "${version}"`);
      if (options.rewriteDependencies ?? true) {
        for (const sibling of projects) {
          stamped = stamped.replace(
            new RegExp(
              `${escapeRegExp(sibling.name)} @ git\\+[^" ]+#subdirectory=[^" ]+/${escapeRegExp(sibling.directory)}`,
              "g",
            ),
            `${sibling.name}==${version}`,
          );
        }
      }
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
}): void {
  const root = resolve(options.root);
  const output = mkdtempSync(join(tmpdir(), "dbx-tools-python-publish-"));
  const stamp = stampPythonProjects(root, options.version);
  try {
    exec.spawnSync("uv", ["build", "--all-packages", "--out-dir", output], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    });
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
    .argument("<version>", "Python package version")
    .requiredOption("--index-url <url>", "devpi Simple API URL")
    .requiredOption("--publish-url <url>", "devpi writable index URL")
    .option("--root <path>", "Python workspace package root", "packages/py")
    .option("--dry-run", "build and inspect distributions without uploading")
    .action(
      (
        version: string,
        options: { dryRun?: boolean; indexUrl: string; publishUrl: string; root: string },
      ) => publishPythonProjects({ ...options, version }),
    );
  await program.parseAsync();
}
