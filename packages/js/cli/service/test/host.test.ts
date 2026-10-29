import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  closeServiceControl,
  listenForServiceControl,
  requestServiceControl,
} from "../src/_control.ts";
import { CliServiceHost } from "../src/_host.ts";
import { resolveServicePaths } from "../src/_paths.ts";
import type { CliServiceDefinition } from "../src/definition.ts";

const DEFINITION: CliServiceDefinition = {
  id: "com.example.gateway",
  name: "Example Gateway",
  packageName: "@example/gateway",
  version: "1.2.3",
  icon: "",
};

describe("CLI service host", () => {
  it("claims singleton control before spawning the managed command", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const marker = join(root, "started");
    const executable = join(root, "command.sh");
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(executable, 0o755);
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const owner = await listenForServiceControl(
      paths.controlAddress,
      () => ({ running: true, pid: 101 }),
      () => {},
    );
    let trayCreated = false;
    const host = new CliServiceHost(
      { ...DEFINITION, command: { executable } },
      paths,
      () => {},
      {
        createTray: () => {
          trayCreated = true;
          throw new Error("tray must not be created");
        },
      },
    );

    await assert.rejects(() => host.start(), /already active/);
    assert.equal(trayCreated, false);
    await assert.rejects(() => stat(marker), { code: "ENOENT" });

    await closeServiceControl(owner, paths.controlAddress);
  });

  it("serves control status without waiting for tray readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const tray = {
      process: null,
      ready: () => new Promise<void>(() => {}),
      onClick: async () => tray,
      onError: () => {},
      onExit: () => {},
    };
    const host = new CliServiceHost(DEFINITION, paths, () => {}, {
      createTray: () => tray as never,
    });

    await host.start();

    assert.deepEqual(await requestServiceControl(paths.controlAddress, "status"), {
      running: true,
      pid: process.pid,
    });
    await host.stop();
    assert.equal(await requestServiceControl(paths.controlAddress, "status"), undefined);
  });
});
