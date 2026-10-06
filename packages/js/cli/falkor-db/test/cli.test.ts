import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProgram, type FalkorDBCliDependencies } from "../src/cli.ts";

describe("FalkorDB CLI", () => {
  it("documents foreground and durability options without service commands", () => {
    const help = buildProgram().helpInformation();

    assert.match(help, /--data-dir/);
    assert.match(help, /--listen/);
    assert.match(help, /--snapshot-seconds/);
    assert.match(help, /--volume/);
    assert.match(help, /--force-backup-on-shutdown/);
    assert.match(help, /FALKORDB_DATA_DIR/);
    assert.match(help, /DATABRICKS_CONFIG_PROFILE/);
    assert.doesNotMatch(help, /\bservice\b/);
  });

  it("runs with typed local and Volume options", async () => {
    const calls: Parameters<FalkorDBCliDependencies["run"]>[0][] = [];
    await buildProgram("dbx falkor-db", {
      async run(options) {
        calls.push(options);
      },
    }).parseAsync(
      [
        "--data-dir",
        "/tmp/graph",
        "--listen",
        "tcp://127.0.0.1:6379",
        "--snapshot-seconds",
        "60",
        "--snapshot-min-changes",
        "2",
        "--volume",
        "/Volumes/main/default/state/falkor",
        "--profile",
        "WORKSPACE",
        "--retention",
        "7",
        "--backup-poll-seconds",
        "5",
        "--stale-backup-warning-seconds",
        "900",
        "--force-backup-on-shutdown",
        "--shutdown-timeout-seconds",
        "20",
        "--max-memory",
        "256mb",
        "--redis-log-level",
        "warning",
        "--startup-timeout-seconds",
        "15",
        "--inherit-stdio",
      ],
      { from: "user" },
    );

    assert.deepEqual(calls, [
      {
        dataDir: "/tmp/graph",
        listen: { scheme: "tcp", host: "127.0.0.1", port: 6379 },
        database: "default_db",
        snapshotSeconds: 60,
        snapshotMinChanges: 2,
        volume: "/Volumes/main/default/state/falkor",
        profile: "WORKSPACE",
        retention: 7,
        backupPollSeconds: 5,
        staleBackupWarningSeconds: 900,
        forceBackupOnShutdown: true,
        shutdownTimeoutSeconds: 20,
        maxMemory: "256mb",
        redisLogLevel: "warning",
        startupTimeoutSeconds: 15,
        inheritStdio: true,
      },
    ]);
  });

  it("accepts a private Unix listener", async () => {
    const calls: Parameters<FalkorDBCliDependencies["run"]>[0][] = [];
    await buildProgram("dbx falkor-db", {
      async run(options) {
        calls.push(options);
      },
    }).parseAsync(["--listen", "unix:///tmp/falkordb.sock"], { from: "user" });

    assert.deepEqual(calls[0]?.listen, {
      scheme: "unix",
      path: "/tmp/falkordb.sock",
    });
  });

  it("allows an ambient profile without Volume storage", async () => {
    const calls: Parameters<FalkorDBCliDependencies["run"]>[0][] = [];
    await buildProgram("dbx falkor-db", {
      async run(options) {
        calls.push(options);
      },
    }).parseAsync(["--profile", "WORKSPACE"], { from: "user" });

    assert.equal(calls[0]?.profile, "WORKSPACE");
    assert.equal(calls[0]?.volume, undefined);
  });

  it("rejects invalid interval values", async () => {
    const dependencies: FalkorDBCliDependencies = {
      async run() {
        assert.fail("runtime must not start");
      },
    };
    await assert.rejects(
      () =>
        buildProgram("dbx falkor-db", dependencies)
          .exitOverride()
          .parseAsync(["--snapshot-seconds", "0"], { from: "user" }),
      /greater than 0|>0/i,
    );
  });
});
