import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { describe, it } from "node:test";

import { projectUtils } from "../index.ts";

describe("resolveWorkingDirectory", () => {
  it("normalizes blank and current-directory values to process.cwd", () => {
    const current = resolve(cwd());
    for (const value of [undefined, null, "", "   ", ".", cwd(), current]) {
      assert.equal(projectUtils.resolveWorkingDirectory(value), current);
    }
  });

  it("resolves another relative directory normally", () => {
    assert.equal(projectUtils.resolveWorkingDirectory(".."), resolve(cwd(), ".."));
  });
});

describe("npmRegistry", () => {
  it("reads a project .npmrc and memoizes by cwd", () => {
    const root = mkdtempSync(resolve(tmpdir(), "dbx-tools-npm-registry-"));
    try {
      const current = resolve(root, "current");
      const other = resolve(root, "other");
      mkdirSync(current);
      mkdirSync(other);
      writeFileSync(resolve(current, ".npmrc"), "registry=https://current.example.test/\n");
      writeFileSync(resolve(other, ".npmrc"), "registry=https://other.example.test/\n");
      const fixture = resolve(import.meta.dir, "fixtures/project-probe.ts");
      const result = spawnSync(process.execPath, [fixture, current, other], {
        encoding: "utf8",
        env: isolatedEnv(root),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        current: [
          "https://current.example.test/",
          "https://current.example.test/",
          "https://current.example.test/",
        ],
        other: ["https://other.example.test/", "https://other.example.test/"],
        moved: ["https://other.example.test/", "https://other.example.test/"],
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("prefers env, then npmrc, then bunfig, then pnpm yaml, then public npm", () => {
    const home = mkdtempSync(resolve(tmpdir(), "dbx-tools-npm-registry-home-"));
    try {
      const project = resolve(home, "project");
      mkdirSync(project);
      writeFileSync(
        resolve(project, "bunfig.toml"),
        `[install]\nregistry = "https://bun.example.test/"\n`,
      );
      writeFileSync(resolve(project, "pnpm-workspace.yaml"), "registry: https://pnpm.example.test/\n");
      assert.equal(
        spawnRegistry(project, home).hostname,
        "bun.example.test",
        "bunfig wins over pnpm yaml",
      );

      writeFileSync(resolve(project, ".npmrc"), 'registry="https://npmrc.example.test/"\n');
      assert.equal(spawnRegistry(project, home).hostname, "npmrc.example.test");

      assert.equal(
        spawnRegistry(project, home, { npm_config_registry: "https://env.example.test/" }).hostname,
        "env.example.test",
      );

      const empty = resolve(home, "empty");
      mkdirSync(empty);
      assert.equal(spawnRegistry(empty, home).hostname, "registry.npmjs.org");
      assert.equal(spawnRegistry(empty, home, { overrideOnly: "1" }), null);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
  delete env.npm_config_registry;
  delete env.NPM_CONFIG_REGISTRY;
  delete env.BUN_CONFIG_REGISTRY;
  delete env.NPM_CONFIG_USERCONFIG;
  delete env.NPM_CONFIG_GLOBALCONFIG;
  Object.assign(env, extra);
  return env;
}

function spawnRegistry(
  cwd: string,
  home: string,
  extra: NodeJS.ProcessEnv = {},
): { hostname: string } | null {
  const fixture = resolve(import.meta.dir, "fixtures/registry-probe.ts");
  const result = spawnSync(process.execPath, [fixture, cwd], {
    encoding: "utf8",
    env: isolatedEnv(home, extra),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { hostname: string } | null;
}
