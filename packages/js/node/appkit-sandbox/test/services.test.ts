import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshCommandResult } from "@dbx-tools/shared-databricks-sandbox";
import { ensureSshService, openDinoTtyProjectTab } from "../src/services.ts";
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

    const target = await ensureSshService(session, "terminal", "/sandbox/terminal/machine", 1_000);

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
    assert.equal(target.openUrl, "/sandbox/terminal/machine");
  });

  it("provisions the branded loopback desktop idempotently", async () => {
    let script = "";
    const session = {
      execute: async (_command: string, args: string[]) => {
        script = args[1] ?? "";
        return success;
      },
    } as unknown as SshSession;

    const target = await ensureSshService(session, "desktop", "/sandbox/desktop/machine", 1_000);

    assert.match(script, /tigervnc-standalone-server/);
    assert.match(script, /websockify --web=\/usr\/share\/novnc 127\.0\.0\.1:6080/);
    assert.match(script, /-localhost yes -SecurityTypes None/);
    assert.match(script, /dbx-tools-wallpaper\.svg/);
    assert.match(script, /#1b3139/);
    assert.match(script, /#0e538b/);
    const encodedWallpaper = script.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
    assert.ok(encodedWallpaper);
    const wallpaper = Buffer.from(encodedWallpaper, "base64").toString("utf8");
    assert.match(wallpaper, /#00a972/);
    assert.match(wallpaper, /#ff3621/);
    assert.match(wallpaper, /dbx\.tools/);
    assert.match(script, /version_file/);
    assert.equal(target.remotePort, 6080);
    assert.equal(target.stripPrefix, true);
    assert.equal(target.redirectToSlash, true);
    assert.equal(
      target.openUrl,
      "/sandbox/desktop/machine/vnc.html?autoconnect=1&resize=remote&path=sandbox%2Fdesktop%2Fmachine%2Fwebsockify",
    );
  });

  it("adds dynamic viewport sizing to the Glances document", async () => {
    const session = {
      execute: async () => success,
    } as unknown as SshSession;

    const target = await ensureSshService(session, "stats", "/sandbox/metrics/machine", 1_000);

    assert.equal(target.redirectToSlash, true);
    assert.match(target.htmlHead ?? "", /dbx-tools-glances-viewport/);
    assert.match(target.htmlHead ?? "", /100svh/);
    assert.match(target.htmlHead ?? "", /#processlist\{height:auto!important/);
    assert.match(target.htmlHead ?? "", /#processlist-table\{[^}]*overflow-x:auto/);
    assert.doesNotMatch(target.htmlHead ?? "", /table-layout:fixed/);
    assert.equal(target.openUrl, "/sandbox/metrics/machine/");
  });

  it("opens a DinoTTY tab in the requested project directory", async () => {
    let command = "";
    let args: string[] = [];
    const session = {
      execute: async (nextCommand: string, nextArgs: string[]) => {
        command = nextCommand;
        args = nextArgs;
        return success;
      },
    } as unknown as SshSession;

    await openDinoTtyProjectTab(session, "/home/sandbox/projects/demo", "demo", 1_000);

    assert.equal(command, "python3");
    assert.equal(args[0], "-c");
    assert.match(args[1] ?? "", /127\.0\.0\.1:7681\/api\/tabs/);
    assert.match(args[1] ?? "", /Authorization.*Bearer databricks-app-oauth/);
    const encoded = (args[1] ?? "").match(/base64\.b64decode\("([^"]+)"\)/)?.[1];
    assert.ok(encoded);
    assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), {
      cwd: "/home/sandbox/projects/demo",
      title: "demo",
    });
  });
});
