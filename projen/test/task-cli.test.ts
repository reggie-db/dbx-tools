import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { z } from "zod";
import { taskCommand, taskName, taskOptions } from "../tasks/cli.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

describe("task CLI integration", () => {
  it("derives stable task names from module URLs", () => {
    assert.equal(taskName(new URL("../tasks/release.ts", import.meta.url).href), "release");
  });

  it("binds flags and task-scoped environment values through cli-args", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dbx-tools-task-cli-"));
    fixtures.push(cwd);
    writeFileSync(join(cwd, ".env"), "DBX_TOOLS_PROJEN_FIXTURE_TASK_WATCH=true\n");
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const schema = z.object({
        watch: z.boolean().default(false).describe("Watch inputs"),
      });
      const moduleUrl = new URL("./fixture-task.ts", import.meta.url).href;
      const command = taskCommand(moduleUrl, "Fixture task", schema);
      assert.deepEqual(await taskOptions(command, schema, []), { watch: true });
    } finally {
      process.chdir(previous);
    }
  });
});
