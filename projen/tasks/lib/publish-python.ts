#!/usr/bin/env -S bun
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { Command } from "commander";
import { parse, stringify } from "smol-toml";
import { preparePythonProjectForPublication, pythonProjectInfo } from "./python-release.ts";
import { runTaskCommand } from "../../src/_task-command.ts";

interface PythonProjectFile {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly private: boolean;
  readonly source: string;
}

/** Python wheel and source archives accepted by Twine and package indexes. */
export function pythonDistributionPaths(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".whl") || file.endsWith(".tar.gz"))
    .sort()
    .map((file) => join(directory, file));
}

function pythonProjects(root: string): PythonProjectFile[] {
  const packageFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name, "pyproject.toml"))
    .filter(existsSync)
    .sort();
  const allProjects: PythonProjectFile[] = packageFiles.map((path) => {
    const source = readFileSync(path, "utf8");
    const info = pythonProjectInfo(source, { parse });
    return {
      directory: basename(resolve(path, "..")),
      name: info.name,
      version: info.version,
      path,
      private: info.private,
      source,
    };
  });
  return allProjects;
}

export function publishPythonProjects(options: {
  readonly dryRun?: boolean;
  readonly indexUrl: string;
  readonly publishUrl: string;
  readonly root: string;
  readonly version: string;
}): void {
  const output = mkdtempSync(join(tmpdir(), "projen-python-publish-"));
  try {
    buildPythonProjects({ ...options, output });
    runTaskCommand(
      process.cwd(),
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
      { env: { ...process.env, UV_DEFAULT_INDEX: options.indexUrl } },
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

/** Build the exact Python release distributions without publishing them. */
export function buildPythonProjects(options: {
  readonly allowEmpty?: boolean;
  readonly output: string;
  readonly packages?: readonly string[];
  readonly root: string;
  readonly version: string;
}): void {
  const root = resolve(options.root);
  const output = resolve(options.output);
  const workspace = projectUtils.root(root) ?? dirname(root);
  const outputPath = relative(workspace, output);
  if (!outputPath || outputPath.startsWith("..") || isAbsolute(outputPath)) {
    throw new Error("Python release output must be a non-root directory inside the workspace");
  }
  rmSync(output, { recursive: true, force: true });
  const allProjects = pythonProjects(root);
  const requested = new Set(options.packages ?? []);
  const missing = [...requested].filter(
    (directory) => !allProjects.some((project) => project.directory === directory),
  );
  if (missing.length > 0) throw new Error(`Unknown Python packages: ${missing.join(", ")}`);
  const projects = allProjects.filter(
    (project) => !project.private && (requested.size === 0 || requested.has(project.directory)),
  );
  if (projects.length === 0 && options.allowEmpty) {
    mkdirSync(output, { recursive: true });
    return;
  }
  if (projects.length === 0) throw new Error(`No Python packages found under ${root}`);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "projen-python-release-"));
  try {
    mkdirSync(output, { recursive: true });
    for (const project of projects) {
      const packageRoot = join(temporaryRoot, project.directory);
      cpSync(dirname(project.path), packageRoot, { recursive: true });
      const manifestPath = join(packageRoot, "pyproject.toml");
      chmodSync(manifestPath, 0o644);
      writeFileSync(
        manifestPath,
        preparePythonProjectForPublication(project.source, {
          packages: allProjects,
          toml: { parse, stringify },
          version: options.version,
        }),
      );
      runTaskCommand(root, "uv", ["build", "--out-dir", output, packageRoot]);
    }
    const distributions = pythonDistributionPaths(output);
    if (distributions.length === 0) {
      throw new Error(`No Python distributions found in ${output}`);
    }
    runTaskCommand(process.cwd(), "uvx", ["twine", "check", ...distributions]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function main(): Promise<void> {
  const program = new Command();
  program
    .argument("<version>", "Python package version")
    .option("--index-url <url>", "devpi Simple API URL")
    .option("--publish-url <url>", "devpi writable index URL")
    .option("--root <path>", "Python workspace package root", "packages/py")
    .option("--package <directory...>", "Build only selected package directories")
    .option("--output <path>", "Build distributions into a directory without publishing")
    .option("--dry-run", "build and inspect distributions without uploading")
    .action(
      (
        version: string,
        options: {
          dryRun?: boolean;
          indexUrl?: string;
          package?: string[];
          publishUrl?: string;
          root: string;
          output?: string;
        },
      ) => {
        if (options.output) {
          buildPythonProjects({
            output: options.output,
            packages: options.package,
            root: options.root,
            version,
          });
        } else {
          if (!options.indexUrl || !options.publishUrl) {
            throw new Error("--index-url and --publish-url are required when publishing");
          }
          publishPythonProjects({
            dryRun: options.dryRun,
            indexUrl: options.indexUrl,
            publishUrl: options.publishUrl,
            root: options.root,
            version,
          });
        }
      },
    );
  await program.parseAsync();
}
