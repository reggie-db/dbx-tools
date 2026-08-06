#!/usr/bin/env -S bun
/**
 * Stamp every Python distribution with a PEP 440 local version before commit.
 *
 * The commit itself does not exist while pre-commit hooks run, so the suffix is
 * derived from Git's hash of the staged patch, excluding Python pyproject files.
 * Excluding those generated files makes retries idempotent after the hook stages
 * the version updates.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "@dbx-tools/shared-core";
import { stampPythonProjects } from "./publish-python.ts";

const logger = log.logger("python:commit-version");
const LOCAL_HASH_LENGTH = 7;

export function pythonCommitVersion(releaseVersion: string, gitHash: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    throw new Error(`Python commit versions require an x.y.z release, got ${releaseVersion}`);
  }
  const normalizedHash = gitHash.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalizedHash)) {
    throw new Error(`Expected a hexadecimal Git hash, got ${gitHash}`);
  }
  return `${releaseVersion}+gh${normalizedHash.slice(0, LOCAL_HASH_LENGTH)}`;
}

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
  }).trim();
}

function stagedContentHash(root: string): string {
  const patch = git(root, [
    "diff",
    "--cached",
    "--binary",
    "--",
    ".",
    ":(exclude)packages/py/*/pyproject.toml",
  ]);
  if (!patch) return git(root, ["rev-parse", "HEAD^{tree}"]);
  return git(root, ["hash-object", "--stdin"], patch);
}

function rootVersion(root: string): string {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new Error("Root package.json needs a string version");
  }
  return manifest.version;
}

export function stampPythonCommitVersion(root: string): string {
  const version = pythonCommitVersion(rootVersion(root), stagedContentHash(root));
  const stamp = stampPythonProjects(resolve(root, "packages/py"), version, {
    rewriteDependencies: false,
  });
  git(root, ["add", "--", ...stamp.paths]);
  return version;
}

if (import.meta.main) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const version = stampPythonCommitVersion(root);
  logger.info(`staged Python packages at ${version}`);
}
