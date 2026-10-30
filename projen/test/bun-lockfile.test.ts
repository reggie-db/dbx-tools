/** `bun.lock` normalization rewrites only the detected private registry. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { javascript } from "projen";

import {
  BUN_LOCKFILE_COMMAND,
  BUN_LOCKFILE_TASK,
  BunLockfile,
  normalizeBunLockfile,
  normalizeBunLockfileAt,
} from "../src/bun-lockfile.ts";

const MIRROR = "https://mirror.example.test/npm";
const LOCK = [
  "{",
  '  "packages": {',
  `    "zod": ["zod@4.1.0", "${MIRROR}/zod/-/zod-4.1.0.tgz", {}, "sha512-a"],`,
  `    "@scope/pkg": ["@scope/pkg@1.0.0", "${MIRROR}/@scope/pkg/-/pkg-1.0.0.tgz", {}, "sha512-b"],`,
  '    "left": ["left@1.0.0", "https://registry.npmjs.org/left/-/left-1.0.0.tgz", {}, "sha512-c"],',
  '    "other": ["other@1.0.0", "https://other.example.test/other/-/other-1.0.0.tgz", {}, "sha512-d"],',
  '    "ws": ["ws@workspace:packages/ws"],',
  "  }",
  "}",
  "",
].join("\n");

const temps: string[] = [];
after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeBunLockfile", () => {
  it("empties tarball URLs under the registry and leaves other URLs", () => {
    const result = normalizeBunLockfile(LOCK, [MIRROR]);
    assert.equal(result.rewritten, 2);
    assert.match(result.content, /"zod@4\.1\.0", "", \{\}, "sha512-a"/);
    assert.match(result.content, /"@scope\/pkg@1\.0\.0", "", \{\}, "sha512-b"/);
    assert.match(result.content, /registry\.npmjs\.org\/left/);
    assert.match(result.content, /other\.example\.test\/other/);
    assert.doesNotMatch(result.content, /mirror\.example\.test/);
  });

  it("rewrites to public npm tarballs on request", () => {
    const result = normalizeBunLockfile(LOCK, [`${MIRROR}/`], "npmjs");
    assert.match(
      result.content,
      /"@scope\/pkg@1\.0\.0", "https:\/\/registry\.npmjs\.org\/@scope\/pkg\/-\/pkg-1\.0\.0\.tgz"/,
    );
    assert.doesNotMatch(result.content, /mirror\.example\.test/);
  });

  it("is a no-op without a private registry", () => {
    assert.equal(normalizeBunLockfile(LOCK, []).content, LOCK);
  });
});

describe("normalizeBunLockfileAt", () => {
  const withLock = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bun-lockfile-"));
    temps.push(dir);
    writeFileSync(join(dir, "bun.lock"), LOCK);
    return dir;
  };

  it("uses configured registries, honors check, and is idempotent", () => {
    const dir = withLock();
    const options = { mode: "off" as const, registries: [MIRROR] };
    assert.equal(normalizeBunLockfileAt(dir, options).changed, false);

    const auto = { registries: [MIRROR] };
    const checked = normalizeBunLockfileAt(dir, { ...auto, check: true });
    assert.equal(checked.changed, true);
    assert.equal(readFileSync(join(dir, "bun.lock"), "utf8"), LOCK);

    assert.equal(normalizeBunLockfileAt(dir, auto).changed, true);
    assert.doesNotMatch(readFileSync(join(dir, "bun.lock"), "utf8"), /mirror\.example\.test/);
    assert.equal(normalizeBunLockfileAt(dir, auto).changed, false);
  });
});

describe("BunLockfile", () => {
  it("adds registry-neutral lockfile ownership to a vanilla Projen project", () => {
    process.env.PROJEN_DISABLE_POST = "1";
    const outdir = mkdtempSync(join(tmpdir(), "bun-lockfile-component-"));
    temps.push(outdir);
    const project = new javascript.NodeProject({
      defaultReleaseBranch: "main",
      name: "fixture",
      outdir,
      packageManager: javascript.NodePackageManager.BUN,
    });

    new BunLockfile(project);
    project.synth();

    const manifest = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    assert.equal(manifest.scripts?.postinstall, BUN_LOCKFILE_COMMAND.join(" "));

    const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
      tasks: Record<
        string,
        {
          steps?: Array<{
            exec?: string;
            execArgs?: string[];
            receiveArgs?: boolean;
            spawn?: string;
          }>;
        }
      >;
    };
    assert.deepEqual(tasks.tasks[BUN_LOCKFILE_TASK]?.steps, [
      { execArgs: [...BUN_LOCKFILE_COMMAND], receiveArgs: true },
    ]);
    assert.deepEqual(tasks.tasks.install?.steps, [
      { exec: "bun install" },
      { spawn: BUN_LOCKFILE_TASK },
    ]);
    assert.deepEqual(tasks.tasks["install:ci"]?.steps, [
      { exec: "bun install --frozen-lockfile" },
    ]);

    const gitignore = readFileSync(join(outdir, ".gitignore"), "utf8").split("\n");
    assert.ok(gitignore.includes("!/bun.lock"));
    assert.match(
      readFileSync(join(outdir, ".gitattributes"), "utf8"),
      /^\/bun\.lock linguist-generated$/m,
    );
  });
});
