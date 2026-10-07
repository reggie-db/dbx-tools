import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { compileWithBun } from "../src/_compile.ts";

describe("CLI service Bun compilation", () => {
  it("removes isolated and working-directory artifacts after compiler failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-compile-"));
    try {
      const temporaryDirectory = join(root, "temporary");
      const workingDirectory = join(root, "working");
      const executable = join(root, "bun");
      const recordedWorkingDirectory = join(root, "cwd");
      const existingArtifact = join(workingDirectory, ".existing.bun-build");
      const leakedArtifact = join(workingDirectory, ".leaked.bun-build");
      await mkdir(temporaryDirectory);
      await mkdir(workingDirectory);
      await writeFile(existingArtifact, "existing");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `pwd > ${JSON.stringify(recordedWorkingDirectory)}`,
          'touch "$PWD/.isolated.bun-build"',
          `touch ${JSON.stringify(leakedArtifact)}`,
          "exit 7",
        ].join("\n"),
      );
      await chmod(executable, 0o755);

      await assert.rejects(() =>
        compileWithBun(
          executable,
          join(workingDirectory, "entrypoint.ts"),
          join(root, "output"),
          workingDirectory,
          [],
          temporaryDirectory,
        ),
      );

      assert.deepEqual(await readdir(temporaryDirectory), []);
      assert.match(await readFile(recordedWorkingDirectory, "utf8"), /dbx-tools-bun-compile-/);
      await stat(existingArtifact);
      await assert.rejects(() => stat(leakedArtifact), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
