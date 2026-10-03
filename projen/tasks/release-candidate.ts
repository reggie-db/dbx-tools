#!/usr/bin/env -S bun
/** Build and optionally upload the complete locally approved release candidate. */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as exec from "@dbx-tools/core/exec";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { json, log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import type { RustReleaseConfiguration } from "../src/_rust-release-workflow.ts";
import { buildPythonProjects } from "./publish-python.ts";
import { readNpmArchiveIdentity } from "./publish-npm.ts";
import { buildReleaseAssets } from "./release-assets.ts";
import {
  type ReleaseArtifactInput,
  type ReleaseArtifactRole,
  writeReleaseManifest,
} from "./release-manifest.ts";

const logger = log.logger("projen:release-candidate");

function run(root: string, command: string, args: readonly string[], env = process.env): void {
  exec.spawnSync(command, [...args], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    check: true,
  });
}

function capture(
  root: string,
  command: string,
  args: readonly string[],
  env = process.env,
): string {
  return exec
    .spawnSync(command, [...args], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "capture",
      stderr: "inherit",
      check: true,
    })
    .stdout.trim();
}

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function pythonPackageName(path: string, version: string): string {
  const name = basename(path);
  const marker = `-${version}`;
  const index = name.indexOf(marker);
  if (index <= 0) throw new Error(`Cannot resolve Python package name from ${name}`);
  return name.slice(0, index).replace(/[_.]+/g, "-").toLowerCase();
}

function role(path: string): ReleaseArtifactRole {
  const normalized = path.split("\\").join("/");
  if (normalized.includes("/npm-facade/")) return "facade";
  if (normalized.includes("/npm-workspace/") || normalized.includes("/python-workspace/")) {
    return "workspace";
  }
  return "native";
}

function releaseArtifacts(root: string, version: string): ReleaseArtifactInput[] {
  const releaseRoot = join(root, "dist/release");
  return files(releaseRoot)
    .filter((path) => !path.includes(`${join(releaseRoot, "upload")}/`))
    .flatMap((path): ReleaseArtifactInput[] => {
      const normalized = path.split("\\").join("/");
      if (path.endsWith(".tgz")) {
        const identity = readNpmArchiveIdentity(path);
        if (identity.version !== version) {
          throw new Error(`${identity.name} carries ${identity.version}, expected ${version}`);
        }
        return [
          {
            kind: "npm",
            packageName: identity.name,
            packageVersion: identity.version,
            path,
            role: role(path),
          },
        ];
      }
      if (
        path.endsWith(".whl") ||
        (path.endsWith(".tar.gz") &&
          (normalized.includes("/python/") || normalized.includes("/python-workspace/")))
      ) {
        return [
          {
            kind: "pypi",
            packageName: pythonPackageName(path, version),
            packageVersion: version,
            path,
            role: role(path),
          },
        ];
      }
      if (path.endsWith(".zip") || path.endsWith(".tar.gz")) {
        return [{ kind: "binary", path }];
      }
      return [];
    });
}

function pruneDraftAssets(
  root: string,
  tag: string,
  desired: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): void {
  const current = capture(
    root,
    "gh",
    ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"],
    env,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  for (const name of current) {
    if (!desired.has(name)) {
      run(root, "gh", ["release", "delete-asset", tag, name, "--yes"], env);
    }
  }
}

function rustReleaseConfiguration(root: string): RustReleaseConfiguration | undefined {
  const path = join(root, ".projen/rust-release.json");
  return existsSync(path)
    ? (json.parse(readFileSync(path, "utf8")) as RustReleaseConfiguration)
    : undefined;
}

function buildFacades(root: string, version: string): void {
  const configuration = rustReleaseConfiguration(root);
  if (!configuration) return;
  for (const binding of configuration.bindings) {
    if (!binding.node || !binding.nodePackage) continue;
    run(root, "node", [
      ".projen/uniffi-release.mjs",
      "facade",
      "--node",
      binding.node,
      "--node-package",
      binding.nodePackage,
      "--node-triple",
      "linux-x64-gnu",
      "--version",
      version,
      "--output",
      `dist/release/${binding.crate}/facade`,
    ]);
  }
}

function ensureDraftRelease(options: {
  readonly root: string;
  readonly sha: string;
  readonly tag: string;
  readonly notesFile?: string;
  readonly env: NodeJS.ProcessEnv;
}): void {
  const existingTag = exec.spawnSync("git", ["rev-parse", "--verify", `${options.tag}^{commit}`], {
    cwd: options.root,
    env: options.env,
    stdin: "ignore",
    stdout: "capture",
    stderr: "ignore",
    check: false,
  });
  if (existingTag.exitCode === 0) {
    if (existingTag.stdout.trim() !== options.sha) {
      throw new Error(`Release tag ${options.tag} does not point to ${options.sha}`);
    }
    if (capture(options.root, "git", ["cat-file", "-t", options.tag], options.env) !== "tag") {
      throw new Error(`Release tag ${options.tag} must be annotated`);
    }
  } else {
    run(
      options.root,
      "git",
      ["tag", "-a", options.tag, options.sha, "-m", options.tag],
      options.env,
    );
  }
  const remoteTag = exec.spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${options.tag}`],
    {
      cwd: options.root,
      env: options.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      check: false,
    },
  );
  if (remoteTag.exitCode === 0) {
    run(
      options.root,
      "git",
      ["fetch", "--force", "origin", `+refs/tags/${options.tag}:refs/tags/${options.tag}`],
      options.env,
    );
    if (
      capture(options.root, "git", ["rev-parse", `${options.tag}^{commit}`], options.env) !==
      options.sha
    ) {
      throw new Error(`Remote release tag ${options.tag} does not point to ${options.sha}`);
    }
    if (capture(options.root, "git", ["cat-file", "-t", options.tag], options.env) !== "tag") {
      throw new Error(`Remote release tag ${options.tag} must be annotated`);
    }
  } else {
    run(options.root, "git", ["push", "origin", `refs/tags/${options.tag}`], options.env);
  }

  const release = exec.spawnSync("gh", ["release", "view", options.tag, "--json", "isDraft"], {
    cwd: options.root,
    env: options.env,
    stdin: "ignore",
    stdout: "capture",
    stderr: "ignore",
    check: false,
  });
  if (release.exitCode === 0) {
    const state = JSON.parse(release.stdout) as { isDraft?: boolean };
    if (state.isDraft !== true)
      throw new Error(`GitHub Release ${options.tag} is already published`);
    if (options.notesFile) {
      run(
        options.root,
        "gh",
        ["release", "edit", options.tag, "--title", options.tag, "--notes-file", options.notesFile],
        options.env,
      );
    }
    return;
  }
  const notes =
    options.notesFile && existsSync(options.notesFile) ? ["--notes-file", options.notesFile] : [];
  run(
    options.root,
    "gh",
    ["release", "create", options.tag, "--draft", "--verify-tag", "--title", options.tag, ...notes],
    options.env,
  );
}

/** Build the exact release candidate and optionally attach it to a draft release. */
export function buildReleaseCandidate(options: {
  readonly root: string;
  readonly sha: string;
  readonly tag: string;
  readonly version: string;
  readonly notesFile?: string;
  readonly upload?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): void {
  const root = resolve(options.root);
  const env = options.env ?? process.env;
  if (capture(root, "git", ["rev-parse", "HEAD"], env) !== options.sha) {
    throw new Error(`Release candidate must be built from ${options.sha}`);
  }
  if (readFileSync(join(root, "VERSION"), "utf8").trim() !== options.version) {
    throw new Error(`VERSION does not match ${options.version}`);
  }
  const status = capture(root, "git", ["status", "--porcelain=v1", "--untracked-files=all"], env);
  if (status) throw new Error("Release candidate source contains tracked changes");

  rmSync(join(root, "dist/release"), { recursive: true, force: true });
  if ((rustReleaseConfiguration(root)?.targets.length ?? 0) > 0) {
    buildReleaseAssets({ root, version: options.version });
    buildFacades(root, options.version);
  }
  const publishScript = fileURLToPath(new URL("./publish.ts", import.meta.url));
  run(root, process.execPath, [
    publishScript,
    options.version,
    "--output",
    "dist/release/npm-workspace",
  ]);
  const pythonRoot = join(root, "packages/py");
  if (existsSync(pythonRoot)) {
    buildPythonProjects({
      allowEmpty: true,
      excludeUniFFI: true,
      output: join(root, "dist/release/python-workspace"),
      root: pythonRoot,
      version: options.version,
    });
  }
  const uploadDirectory = join(root, "dist/release/upload");
  const manifest = writeReleaseManifest({
    artifacts: releaseArtifacts(root, options.version),
    directory: uploadDirectory,
    gitSha: options.sha,
    tag: options.tag,
    version: options.version,
  });
  logger.success("built release candidate", {
    artifacts: manifest.artifacts.length,
    sha: options.sha,
    tag: options.tag,
  });
  if (!options.upload) return;
  const notesFile = join(root, "dist/release/release-notes.md");
  const summary =
    options.notesFile && existsSync(resolve(root, options.notesFile))
      ? readFileSync(resolve(root, options.notesFile), "utf8").trim()
      : "";
  writeFileSync(
    notesFile,
    [
      `Release commit: \`${options.sha}\``,
      "",
      "Candidate manifest: `release-manifest.json`",
      "",
      "Candidate checksums: `SHA256SUMS`",
      ...(summary ? ["", summary] : []),
      "",
    ].join("\n"),
  );
  ensureDraftRelease({
    root,
    sha: options.sha,
    tag: options.tag,
    notesFile,
    env,
  });
  const uploadFiles = files(uploadDirectory).sort((left, right) => {
    const priority = (path: string): number =>
      basename(path) === "release-manifest.json" ? 2 : basename(path) === "SHA256SUMS" ? 1 : 0;
    return priority(left) - priority(right) || left.localeCompare(right);
  });
  pruneDraftAssets(root, options.tag, new Set(uploadFiles.map((path) => basename(path))), env);
  run(root, "gh", ["release", "upload", options.tag, ...uploadFiles, "--clobber"], env);
  logger.success(`uploaded draft release candidate ${options.tag}`);
}

if (import.meta.main) {
  new Command()
    .requiredOption("--version <version>", "release version")
    .requiredOption("--tag <tag>", "annotated release tag")
    .requiredOption("--sha <sha>", "exact release commit")
    .option("--root <path>", "repository root")
    .option("--notes-file <path>", "draft release notes file")
    .option("--upload", "create or update the draft GitHub Release")
    .action(
      (options: {
        version: string;
        tag: string;
        sha: string;
        root?: string;
        notesFile?: string;
        upload?: boolean;
      }) => {
        buildReleaseCandidate({
          root: options.root ?? projectUtils.root() ?? process.cwd(),
          sha: options.sha,
          tag: options.tag,
          version: options.version,
          ...(options.notesFile ? { notesFile: options.notesFile } : {}),
          upload: options.upload,
        });
      },
    )
    .parse();
}
