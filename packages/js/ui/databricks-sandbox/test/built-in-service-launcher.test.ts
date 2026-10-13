import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshMachineService } from "@dbx-tools/shared-databricks-sandbox";
import {
  openBuiltInServiceWhenReady,
  selectedBuiltInServiceLog,
} from "../src/react/built-in-service-launcher.tsx";

const snapshot = (state: SshMachineService["state"]): SshMachineService => ({
  kind: "terminal",
  path: "/sandbox/terminal/machine-1",
  openUrl: "/sandbox/terminal/machine-1/",
  state,
});

describe("openBuiltInServiceWhenReady", () => {
  it("does not open a tab until the lifecycle stream reports ready", async () => {
    let releaseReady: (() => void) | undefined;
    let observedStarting: (() => void) | undefined;
    const starting = new Promise<void>((resolve) => {
      observedStarting = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    async function* snapshots(): AsyncIterable<SshMachineService> {
      yield snapshot("starting");
      observedStarting?.();
      await ready;
      yield snapshot("ready");
    }
    const opened: string[] = [];
    const observed: string[] = [];

    const result = openBuiltInServiceWhenReady(
      snapshots(),
      "Terminal",
      (current) => observed.push(current.state),
      (path) => opened.push(path),
    );
    await starting;
    assert.deepEqual(opened, []);

    releaseReady?.();
    assert.equal((await result).state, "ready");
    assert.deepEqual(observed, ["starting", "ready"]);
    assert.deepEqual(opened, ["/sandbox/terminal/machine-1/"]);
  });

  it("does not open a tab when provisioning fails", async () => {
    async function* snapshots(): AsyncIterable<SshMachineService> {
      yield snapshot("starting");
      yield { ...snapshot("error"), error: "install failed" };
    }
    const opened: string[] = [];

    await assert.rejects(
      openBuiltInServiceWhenReady(
        snapshots(),
        "Terminal",
        () => undefined,
        (path) => {
          opened.push(path);
        },
      ),
      /install failed/,
    );
    assert.deepEqual(opened, []);
  });

  it("opens as soon as ready without waiting for the stream to close", async () => {
    let releaseStream: (() => void) | undefined;
    const streamClosed = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* snapshots(): AsyncIterable<SshMachineService> {
      yield snapshot("starting");
      yield snapshot("ready");
      await streamClosed;
    }
    const opened: string[] = [];

    const result = await openBuiltInServiceWhenReady(
      snapshots(),
      "Terminal",
      () => undefined,
      (path) => opened.push(path),
    );

    assert.equal(result.state, "ready");
    assert.deepEqual(opened, ["/sandbox/terminal/machine-1/"]);
    releaseStream?.();
  });
});

describe("selectedBuiltInServiceLog", () => {
  it("returns only the selected service", () => {
    const machine = {
      id: "machine-1",
      services: [
        snapshot("starting"),
        { ...snapshot("ready"), kind: "desktop" as const },
        { ...snapshot("starting"), kind: "stats" as const },
      ],
    } as Parameters<typeof selectedBuiltInServiceLog>[0];

    assert.equal(selectedBuiltInServiceLog(machine, "desktop")?.kind, "desktop");
    assert.equal(selectedBuiltInServiceLog(machine, "stats")?.kind, "stats");
    assert.equal(selectedBuiltInServiceLog(machine, undefined), undefined);
  });
});
