import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveServicePaths } from "../src/_paths.ts";
import {
  installStartup,
  renderDesktopEntry,
  renderLaunchAgent,
  renderWindowsStartup,
} from "../src/_startup.ts";
import type { CliServiceDefinition } from "../src/definition.ts";

const DEFINITION: CliServiceDefinition = {
  id: "com.example.gateway",
  name: "Example Gateway",
  packageName: "@example/gateway",
  version: "1.2.3",
  icon: "/Applications/Example & Gateway/icon.png",
};

const LAUNCH = {
  executable: "/opt/node/bin/node",
  arguments: ["/opt/example/host.js", "--service-config", "/Users/test/App Data/service.json"],
};

describe("CLI service startup entries", () => {
  it("re-enables the macOS LaunchAgent during installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-startup-"));
    const binDirectory = join(root, "bin");
    const launchctlLog = join(root, "launchctl.log");
    await mkdir(binDirectory);
    const launchctl = join(binDirectory, "launchctl");
    await writeFile(launchctl, '#!/bin/sh\nprintf "%s\\n" "$@" > "$LAUNCHCTL_LOG"\n');
    await chmod(launchctl, 0o755);
    const runtime = {
      platform: "darwin" as const,
      environment: {
        PATH: binDirectory,
        LAUNCHCTL_LOG: launchctlLog,
      },
      homeDirectory: root,
      temporaryDirectory: root,
      userId: 502,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);

    await installStartup(DEFINITION, paths, runtime, LAUNCH);

    assert.equal(
      await readFile(launchctlLog, "utf8"),
      `enable\ngui/${runtime.userId}/${DEFINITION.id}\n`,
    );
    assert.match(await readFile(paths.startupFile, "utf8"), /<key>RunAtLoad<\/key>/);
  });

  it("renders a macOS per-user LaunchAgent", () => {
    const content = renderLaunchAgent(DEFINITION, LAUNCH);

    assert.match(content, /<string>com\.example\.gateway<\/string>/);
    assert.match(content, /<key>RunAtLoad<\/key>/);
    assert.match(content, /<string>\/opt\/node\/bin\/node<\/string>/);
  });

  it("renders a Linux XDG autostart entry with quoted arguments", () => {
    const content = renderDesktopEntry(DEFINITION, LAUNCH);

    assert.match(content, /^Type=Application$/m);
    assert.match(content, /^Name=Example Gateway$/m);
    assert.match(content, /Exec="\/opt\/node\/bin\/node"/);
  });

  it("renders a Windows current-user Startup command", () => {
    const content = renderWindowsStartup({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      arguments: ["C:\\Example App\\host.js"],
    });

    assert.match(content, /^@echo off\r$/m);
    assert.match(content, /start "" \/b "C:\\Program Files\\nodejs\\node\.exe"/);
  });
});
