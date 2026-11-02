import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

const PROCESS_TREE_FIXTURE = join(import.meta.dirname, "fixtures", "process-tree.cjs");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function readProcessTree(path: string): Promise<{ parentPid: number; childPid: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        parentPid: number;
        childPid: number;
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`process tree did not start: ${path}`);
}

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
    const host = new CliServiceHost({ ...DEFINITION, command: { executable } }, paths, () => {}, {
      createTray: () => {
        trayCreated = true;
        throw new Error("tray must not be created");
      },
    });

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

  it("waits for the authentication preflight before starting the managed command", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const authRuns = join(root, "auth-runs");
    const started = join(root, "started");
    const authExecutable = join(root, "auth.sh");
    const executable = join(root, "command.sh");
    await writeFile(
      authExecutable,
      [
        "#!/bin/sh",
        `echo run >> '${authRuns}'`,
        `[ "$(wc -l < '${authRuns}')" -lt 3 ] && exit 1`,
        "exit 0",
        "",
      ].join("\n"),
    );
    await writeFile(executable, `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`);
    await chmod(authExecutable, 0o755);
    await chmod(executable, 0o755);
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const tray = {
      process: null,
      ready: async () => {},
      onClick: async () => tray,
      onError: () => {},
      onExit: () => {},
    };
    const host = new CliServiceHost(
      {
        ...DEFINITION,
        waitForAuth: "auto",
        authCommand: { executable: authExecutable },
        command: { executable },
      },
      paths,
      () => {},
      {
        createTray: () => tray as never,
        restartBackoff: {
          delaysMilliseconds: [10],
          stableMilliseconds: 60_000,
        },
      },
    );

    try {
      await host.start();
      let servicePid: number | undefined;
      let serviceStarted = false;
      for (let attempt = 0; attempt < 200 && !serviceStarted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        servicePid = (await requestServiceControl(paths.controlAddress, "status"))?.servicePid;
        serviceStarted = Boolean(await stat(started).catch(() => undefined));
      }

      assert.ok(servicePid, "managed command did not start after authentication");
      assert.equal(serviceStarted, true);
      assert.equal((await readFile(authRuns, "utf8")).split("\n").filter(Boolean).length, 3);
      assert.match(
        await readFile(paths.hostLog, "utf8"),
        /authentication preflight exited \(1\); retrying in 0\.01s\n.*authentication preflight succeeded/s,
      );
    } finally {
      await host.stop();
    }
  });

  it("skips the authentication preflight when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const authStarted = join(root, "auth-started");
    const serviceStarted = join(root, "service-started");
    const authExecutable = join(root, "auth.sh");
    const executable = join(root, "command.sh");
    await writeFile(authExecutable, `#!/bin/sh\ntouch '${authStarted}'\n`);
    await writeFile(executable, `#!/bin/sh\ntouch '${serviceStarted}'\nexec sleep 30\n`);
    await chmod(authExecutable, 0o755);
    await chmod(executable, 0o755);
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const tray = {
      process: null,
      ready: async () => {},
      onClick: async () => tray,
      onError: () => {},
      onExit: () => {},
    };
    const host = new CliServiceHost(
      {
        ...DEFINITION,
        waitForAuth: "false",
        authCommand: { executable: authExecutable },
        command: { executable },
      },
      paths,
      () => {},
      { createTray: () => tray as never },
    );

    try {
      await host.start();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await stat(serviceStarted).catch(() => undefined)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await stat(serviceStarted);
      await assert.rejects(() => stat(authStarted), { code: "ENOENT" });
    } finally {
      await host.stop();
    }
  });

  it("restarts a managed command that exits early", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const runs = join(root, "runs");
    const executable = join(root, "command.sh");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        `echo run >> '${runs}'`,
        `[ "$(wc -l < '${runs}')" -lt 3 ] && exit 1`,
        "exec sleep 30",
        "",
      ].join("\n"),
    );
    await chmod(executable, 0o755);
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const tray = {
      process: null,
      ready: async () => {},
      onClick: async () => tray,
      onError: () => {},
      onExit: () => {},
    };
    let stopRequested = false;
    const host = new CliServiceHost(
      { ...DEFINITION, command: { executable } },
      paths,
      () => {
        stopRequested = true;
      },
      {
        createTray: () => tray as never,
        restartBackoff: {
          delaysMilliseconds: [10, 20],
          stableMilliseconds: 60_000,
        },
      },
    );

    try {
      await host.start();
      let servicePid: number | undefined;
      for (let attempt = 0; attempt < 200 && servicePid === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const lines = await readFile(runs, "utf8").catch(() => "");
        if (lines.split("\n").filter(Boolean).length < 3) continue;
        const status = await requestServiceControl(paths.controlAddress, "status");
        servicePid = status?.servicePid;
      }

      assert.equal(stopRequested, false);
      assert.ok(servicePid, "managed command was not restarted");
      assert.equal(processExists(servicePid), true);
      assert.match(
        await readFile(paths.hostLog, "utf8"),
        /managed service exited \(1\); restarting in 0\.01s\n.*managed service exited \(1\); restarting in 0\.02s/,
      );

      await host.stop();
      assert.equal(processExists(servicePid), false);
    } finally {
      await host.stop();
    }
  });

  it("cancels a pending restart when stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const runs = join(root, "runs");
    const executable = join(root, "command.sh");
    await writeFile(executable, `#!/bin/sh\necho run >> '${runs}'\nexit 1\n`);
    await chmod(executable, 0o755);
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const tray = {
      process: null,
      ready: async () => {},
      onClick: async () => tray,
      onError: () => {},
      onExit: () => {},
    };
    const host = new CliServiceHost({ ...DEFINITION, command: { executable } }, paths, () => {}, {
      createTray: () => tray as never,
      restartBackoff: {
        delaysMilliseconds: [200, 200],
        stableMilliseconds: 60_000,
      },
    });

    await host.start();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(paths.hostLog, "utf8").catch(() => "")).includes("restarting")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await host.stop();
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal((await readFile(runs, "utf8")).split("\n").filter(Boolean).length, 1);
  });

  it("stops the managed command and its descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-host-"));
    const statePath = join(root, "process-tree.json");
    const runtime = {
      platform: "linux" as const,
      environment: {},
      homeDirectory: root,
      temporaryDirectory: root,
    };
    const paths = resolveServicePaths(DEFINITION, runtime);
    const tray = {
      process: null,
      ready: async () => {},
      onClick: async () => tray,
      onError: () => {},
      onExit: () => {},
    };
    const host = new CliServiceHost(
      {
        ...DEFINITION,
        command: {
          executable: process.execPath,
          arguments: [PROCESS_TREE_FIXTURE, statePath],
        },
      },
      paths,
      () => {},
      { createTray: () => tray as never },
    );

    let tree: { parentPid: number; childPid: number } | undefined;
    try {
      await host.start();
      tree = await readProcessTree(statePath);
      assert.equal(processExists(tree.parentPid), true);
      assert.equal(processExists(tree.childPid), true);

      await host.stop();

      assert.equal(processExists(tree.parentPid), false);
      assert.equal(processExists(tree.childPid), false);
    } finally {
      forceKill(tree?.childPid);
      forceKill(tree?.parentPid);
    }
  });
});
