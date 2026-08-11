import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";

import { installFrp } from "../src/frp.ts";

const logger = log.logger("tunnel:frp-install-test");
const liveIt = process.env.RUN_LIVE_INSTALL_TEST === "1" ? it : it.skip;

describe("frpc live install", () => {
  liveIt("downloads the pinned release into an isolated temporary home", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "frpc-install-"));
    try {
      const childEnv = await installFrp({ homeDir });
      const path = join(homeDir, ".frpc", "bin", "frpc");
      await access(path, constants.X_OK);

      const version = await exec.spawn(path, ["--version"], {
        check: true,
        stderr: "capture",
        stdout: "capture",
      });
      const output = version.stdout.trim() || version.stderr.trim();

      assert.equal(childEnv.HOME, homeDir);
      assert.equal(output, "0.68.1");
      logger.info("frpc live install complete", { homeDir, path, output });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
