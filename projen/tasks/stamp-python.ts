#!/usr/bin/env -S bun
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { parse, stringify } from "smol-toml";
import { pythonProjectInfo, stampPythonProject } from "./uniffi-python.js";

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

/** Stamp publishable Python manifests and return a byte-preserving restore callback. */
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

  const restoreProjects = () => {
    for (const project of projects) {
      chmodSync(project.path, project.mode | 0o200);
      writeFileSync(project.path, project.source);
      chmodSync(project.path, project.mode);
    }
  };
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
    restoreProjects();
    throw error;
  }

  Object.defineProperty(restoreProjects, "paths", {
    value: projects.map((project) => project.path),
  });
  return restoreProjects as RestorePythonProjects;
}

if (import.meta.main) {
  const program = new Command();
  program
    .argument("<version>", "Python package version")
    .option("--root <path>", "Python workspace package root", "packages/py")
    .action((version: string, options: { root: string }) => {
      stampPythonProjects(options.root, version);
    });

  await program.parseAsync();
}
