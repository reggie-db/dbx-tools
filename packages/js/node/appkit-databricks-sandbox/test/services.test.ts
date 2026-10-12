import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshCommandResult } from "@dbx-tools/shared-databricks-sandbox";
import { ensureSshService } from "../src/services.ts";
import type { SshSession } from "../src/session.ts";

const success: SshCommandResult = {
  command: "bash",
  args: ["-lc"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  success: true,
  durationMs: 1,
};

describe("ensureSshService", () => {
  it("upgrades DinoTTY by pinned version and uses its native browser relay", async () => {
    let script = "";
    const session = {
      execute: async (_command: string, args: string[]) => {
        script = args[1] ?? "";
        return success;
      },
    } as unknown as SshSession;

    const target = await ensureSshService(session, "terminal", "/sandbox/machine/terminal", 1_000);

    assert.match(script, /DINOTTY_VERSION=0\.29\.0/);
    assert.match(script, /dinotty\.version/);
    assert.match(script, /kill "\$\(cat "\$pid_file"\)"/);
    assert.equal(target.browserRelay, true);
    assert.deepEqual(target.browserPaths, [
      "/assets",
      "/icons",
      "/manifest.json",
      "/logo.png",
      "/preview",
      "/mcp",
    ]);
    assert.match(target.htmlHead ?? "", /dbx-tools-dinotty-relay/);
    assert.match(target.htmlHead ?? "", /\.status-bar-server-wrap\{display:none!important\}/);
  });

  it("adds dynamic viewport sizing to the Glances document", async () => {
    const session = {
      execute: async () => success,
    } as unknown as SshSession;

    const target = await ensureSshService(session, "stats", "/sandbox/machine/stats", 1_000);

    assert.equal(target.redirectToSlash, true);
    assert.match(target.htmlHead ?? "", /dbx-tools-glances-viewport/);
    assert.match(target.htmlHead ?? "", /100svh/);
    assert.match(target.htmlHead ?? "", /#processlist\{height:auto!important/);
    assert.match(target.htmlHead ?? "", /#processlist-table\{[^}]*overflow-x:auto/);
    assert.doesNotMatch(target.htmlHead ?? "", /table-layout:fixed/);
  });
});
