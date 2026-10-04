import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  databricksCliPat,
  resetDatabricksCliResolution,
  resolveDatabricksCli,
} from "../src/databricks-cli.ts";

describe("Databricks CLI resolution", () => {
  it("reuses an installed CLI that satisfies the JSON token contract", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-databricks-cli-"));
    const executable = join(directory, "databricks");
    try {
      await writeFile(executable, "#!/bin/sh\necho 'Databricks CLI v0.296.0'\n");
      await chmod(executable, 0o755);
      resetDatabricksCliResolution();
      assert.equal(await resolveDatabricksCli({ DATABRICKS_CLI_PATH: executable }), executable);
    } finally {
      resetDatabricksCliResolution();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves PAT credentials through the CLI auth description", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-databricks-pat-"));
    const executable = join(directory, "databricks");
    try {
      await writeFile(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"details":{"configuration":{"token":{"value":"profile-token"}}}}\'\n',
      );
      await chmod(executable, 0o755);
      const token = await databricksCliPat("PAT", executable, {
        DATABRICKS_CONFIG_FILE: join(directory, "config"),
      });
      assert.deepEqual(token, {
        accessToken: "profile-token",
        tokenType: "Bearer",
        scopes: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
