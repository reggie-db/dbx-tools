import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderDesktopEntry, renderLaunchAgent, renderWindowsStartup } from "../src/_startup.ts";
import type { CliServiceDefinition } from "../src/definition.ts";

const DEFINITION: CliServiceDefinition = {
  id: "com.example.gateway",
  name: "Example Gateway",
  version: "1.2.3",
  icon: "/Applications/Example & Gateway/icon.png",
};

const LAUNCH = {
  executable: "/opt/node/bin/node",
  arguments: ["/opt/example/host.js", "--service-config", "/Users/test/App Data/service.json"],
};

describe("CLI service startup entries", () => {
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
