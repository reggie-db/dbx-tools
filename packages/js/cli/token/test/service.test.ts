import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exec } from "@dbx-tools/core";

import { withBrokerServiceLock } from "../src/_lock.ts";
import {
  manageService,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsCommand,
  type ServiceSpec,
} from "../src/service.ts";

const SPEC: ServiceSpec = {
  name: "dbx-tools-token-broker",
  description: "Token broker",
  command: "/path with spaces/bun",
  args: ["/path/dbx.js", "token", "serve", "--bind", "127.0.0.1"],
  workingDirectory: "/working path",
  stateDirectory: "/state path",
};

describe("native service definitions", () => {
  it("fails immediately when the service singleton lock is held", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const running = withBrokerServiceLock("singleton-test", async () => {
      acquired();
      await released;
    });

    await ready;
    try {
      await assert.rejects(
        () => withBrokerServiceLock("singleton-test", async () => {}),
        /already running/,
      );
    } finally {
      release();
      await running;
    }
  });

  it("renders a launchd user agent with restart and log paths", () => {
    const source = renderLaunchdPlist("com.dbx-tools.token", SPEC);
    assert.match(source, /<key>KeepAlive<\/key><true\/>/);
    assert.match(source, /\/path with spaces\/bun/);
    assert.match(source, /\/state path\/service\.log/);
  });

  it("quotes systemd and Windows command arguments", () => {
    const unit = renderSystemdUnit(SPEC);
    assert.match(unit, /ExecStart="\/path with spaces\/bun"/);
    assert.match(unit, /Restart=on-failure/);
    assert.equal(
      renderWindowsCommand(SPEC.command, SPEC.args),
      '"/path with spaces/bun" "/path/dbx.js" "token" "serve" "--bind" "127.0.0.1"',
    );
  });

  it("installs and removes a launchd definition through an injected adapter", async () => {
    const home = await mkdtemp(join(tmpdir(), "dbx-token-service-"));
    const calls: string[][] = [];
    const execute = (async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stdout: "running", stderr: "" };
    }) as typeof exec.spawn;
    const spec = { ...SPEC, stateDirectory: join(home, "state") };
    try {
      const installed = await manageService("install", spec, {
        execute,
        home,
        platform: "darwin",
        uid: 501,
      });
      const plist = join(
        home,
        "Library",
        "LaunchAgents",
        "com.dbx-tools.dbx-tools-token-broker.plist",
      );
      assert.equal(installed.running, true);
      assert.match(await readFile(plist, "utf8"), /RunAtLoad/);
      assert.ok(calls.some((call) => call.includes("bootstrap")));

      await manageService("remove", spec, {
        execute,
        home,
        platform: "darwin",
        uid: 501,
      });
      await assert.rejects(() => readFile(plist), /ENOENT/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
