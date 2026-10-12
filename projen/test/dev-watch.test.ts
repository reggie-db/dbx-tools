/** Coverage for the generic development watcher and generated root task. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { DEV_RESTART_DEBOUNCE_MS, DEV_RESTART_KEY } from "../src/dev-watch.ts";
import { DBXToolsNodeProject } from "../src/project.ts";
import {
  devWatchDirectories,
  devWatchTargets,
  isRestartKey,
  parseDevWatchOptions,
  parseWatchGlobOptions,
  serializedWatchGlobArgs,
} from "../tasks/dev-watch.ts";

describe("development command watcher", () => {
  it("parses watcher flags before the pass-through command", () => {
    assert.deepEqual(parseDevWatchOptions(["bun", "server.ts", "--port", "3000"]), {
      command: ["bun", "server.ts", "--port", "3000"],
      debounceMs: DEV_RESTART_DEBOUNCE_MS,
      restartKey: DEV_RESTART_KEY,
      watchInclude: [],
      watchExclude: [],
    });
    assert.deepEqual(
      parseDevWatchOptions([
        "--debounce-ms",
        "250",
        "--restart-key",
        "x",
        "--watch-include",
        "packages/js/ui/**",
        "--watch-exclude",
        "**/*.md",
        "bun",
        "--hot",
        "server.ts",
      ]),
      {
        command: ["bun", "--hot", "server.ts"],
        debounceMs: 250,
        restartKey: "x",
        watchInclude: ["packages/js/ui/**"],
        watchExclude: ["**/*.md"],
      },
    );
    assert.deepEqual(
      parseDevWatchOptions([
        "--watch-include",
        "src/**",
        "--watch-include",
        "test/**",
        "bun",
        "server.ts",
      ]).watchInclude,
      ["src/**", "test/**"],
    );
    assert.throws(
      () => parseDevWatchOptions(["--debounce-ms", "-1", "bun", "server.ts"]),
      /non-negative number/,
    );
    assert.deepEqual(
      parseWatchGlobOptions(["--watch-exclude", "**", "--profile", "unused"]),
      { watchInclude: [], watchExclude: ["**"] },
    );
    assert.deepEqual(
      serializedWatchGlobArgs({
        watchInclude: ["packages/js/ui/**"],
        watchExclude: ["**/*.md"],
      }),
      ["--watch-include", "packages/js/ui/**", "--watch-exclude", "**/*.md"],
    );
  });

  it("matches the configured restart key case-insensitively", () => {
    assert.equal(isRestartKey("r", "r"), true);
    assert.equal(isRestartKey("R", "r"), true);
    assert.equal(isRestartKey("x", "r"), false);
  });

  it("watches the command package and transitive workspace dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-watch-graph-"));
    try {
      writeFileSync(join(root, "package.json"), '{"name":"fixture-root"}\n');
      writeFileSync(
        join(root, "pnpm-workspace.yaml"),
        'packages:\n  - "packages/app"\n  - "packages/lib"\n  - "packages/other"\n',
      );
      for (const directory of ["app", "lib", "other"]) {
        mkdirSync(join(root, "packages", directory, "src"), { recursive: true });
        writeFileSync(join(root, "packages", directory, "src", "index.ts"), "export {};\n");
      }
      writeFileSync(
        join(root, "packages/app/package.json"),
        '{"name":"@fixture/app","dependencies":{"@fixture/lib":"workspace:^"}}\n',
      );
      writeFileSync(join(root, "packages/lib/package.json"), '{"name":"@fixture/lib"}\n');
      writeFileSync(join(root, "packages/other/package.json"), '{"name":"@fixture/other"}\n');

      const expected = [resolve(root, "packages/app"), resolve(root, "packages/lib")].sort();
      assert.deepEqual(devWatchDirectories(["bun", "packages/app/src/index.ts"], root), expected);
      assert.deepEqual(
        devWatchDirectories(["bun", "run", "--filter", "@fixture/app", "dev"], root),
        expected,
      );
      assert.deepEqual(
        devWatchDirectories(["bun", "--cwd", "packages/app", "src/index.ts"], root),
        expected,
      );
      assert.deepEqual(
        devWatchTargets(["bun", "packages/app/src/index.ts"], root, [], ["**/*.md"]),
        { paths: expected, ignore: ["**/*.md"] },
      );
      assert.deepEqual(
        devWatchTargets(["bun", "packages/app/src/index.ts"], root, ["packages/other/**"], []),
        { paths: ["packages/other/**"], ignore: [] },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates the argv-safe root task with argument forwarding", () => {
    process.env.PROJEN_DISABLE_POST = "1";
    const outdir = mkdtempSync(join(tmpdir(), "dev-watch-task-"));
    try {
      const root = new DBXToolsNodeProject({
        name: "dev-watch-fixture",
        outdir,
        defaultTagMixins: false,
      });
      root.synth();

      const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
        tasks: Record<string, { steps?: Array<{ execArgs?: string[]; receiveArgs?: boolean }> }>;
      };
      assert.deepEqual(tasks.tasks["dev:watch"]?.steps?.[0], {
        execArgs: ["bun", "node_modules/@dbx-tools/projen/tasks/dev-watch.ts"],
        receiveArgs: true,
      });
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
