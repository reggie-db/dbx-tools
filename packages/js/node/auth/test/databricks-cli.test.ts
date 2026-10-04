import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DatabricksCliProvider,
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

  it("resolves the CLI only when a U2M token is requested", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-databricks-lazy-"));
    const executable = join(directory, "databricks");
    try {
      await writeFile(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"access_token":"profile-token","token_type":"Bearer"}\'\n',
      );
      await chmod(executable, 0o755);
      let resolutions = 0;
      const provider = new DatabricksCliProvider("USER", () => {
        resolutions += 1;
        return Promise.resolve(executable);
      });
      assert.equal(resolutions, 0);
      assert.equal((await provider.authenticate(1)).accessToken, "profile-token");
      assert.equal(
        (
          await provider.refresh({
            accessToken: "stale",
            tokenType: "Bearer",
            scopes: [],
          })
        ).accessToken,
        "profile-token",
      );
      assert.equal(resolutions, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
