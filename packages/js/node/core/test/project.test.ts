import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { describe, it } from "node:test";

import { project } from "../index.ts";

describe("resolveWorkingDirectory", () => {
  it("normalizes blank and current-directory values to process.cwd", () => {
    const current = resolve(cwd());
    for (const value of [undefined, null, "", "   ", ".", cwd(), current]) {
      assert.equal(project.resolveWorkingDirectory(value), current);
    }
  });

  it("resolves another relative directory normally", () => {
    assert.equal(project.resolveWorkingDirectory(".."), resolve(cwd(), ".."));
  });
});

describe("project command cache", () => {
  it("caches results by command, including across chdir, while bypassing another cwd", () => {
    const root = mkdtempSync(resolve(tmpdir(), "dbx-tools-project-cache-"));
    try {
      const current = resolve(root, "current");
      const other = resolve(root, "other");
      const bin = resolve(root, "bin");
      const counter = resolve(root, "calls");
      mkdirSync(current);
      mkdirSync(other);
      mkdirSync(bin);
      const npm = resolve(bin, "npm");
      writeFileSync(
        npm,
        `#!/bin/sh\necho call >> "$PROJECT_CACHE_COUNTER"\n` +
          `if [ -n "$PROJECT_CACHE_OUTPUT" ]; then echo "$PROJECT_CACHE_OUTPUT"; fi\n`,
      );
      chmodSync(npm, 0o755);
      const fixture = resolve(import.meta.dir, "fixtures/project-probe.ts");
      const result = spawnSync(process.execPath, [fixture, current, other], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PROJECT_CACHE_COUNTER: counter,
          PROJECT_CACHE_OUTPUT: "https://registry.example.test/",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        current: [
          "https://registry.example.test/",
          "https://registry.example.test/",
          "https://registry.example.test/",
        ],
        other: ["https://registry.example.test/", "https://registry.example.test/"],
        moved: ["https://registry.example.test/", "https://registry.example.test/"],
      });
      assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 3);

      writeFileSync(counter, "");
      const empty = spawnSync(process.execPath, [fixture, current, other], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PROJECT_CACHE_COUNTER: counter,
          PROJECT_CACHE_OUTPUT: "",
        },
      });
      assert.equal(empty.status, 0, empty.stderr);
      assert.deepEqual(JSON.parse(empty.stdout), {
        current: [null, null, null],
        other: [null, null],
        moved: [null, null],
      });
      assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 3);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
