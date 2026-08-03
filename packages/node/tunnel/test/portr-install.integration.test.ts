import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { exec } from "@dbx-tools/core";
import { log } from "@dbx-tools/shared-core";

import { installPortr } from "../src/portr.ts";

const logger = log.logger("tunnel:portr-install-test");
const liveIt = process.env.RUN_LIVE_INSTALL_TEST === "1" ? it : it.skip;

describe("portr live install", () => {
  liveIt("downloads the current release into an isolated temporary home", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "portr-install-"));
    try {
      const childEnv = await installPortr({ homeDir });
      const path = join(homeDir, ".portr", "bin", "portr");
      await access(path, constants.X_OK);

      const version = await exec.spawn(path, ["--version"], {
        check: true,
        stderr: "capture",
        stdout: "capture",
      });
      const output = version.stdout.trim() || version.stderr.trim();

      assert.equal(childEnv.HOME, homeDir);
      assert.match(output, /portr/i);
      logger.info("portr live install complete", { homeDir, path, output });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
