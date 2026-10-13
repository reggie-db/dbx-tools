import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshMachineService } from "@dbx-tools/shared-databricks-sandbox";
import {
  selectedBuiltInServiceLog,
  waitForBuiltInServiceReady,
} from "../src/react/built-in-service-launcher.tsx";

const snapshot = (state: SshMachineService["state"]): SshMachineService => ({
  kind: "terminal",
  path: "/sandbox/terminal/machine-1",
  openUrl: "/sandbox/terminal/machine-1/",
  state,
});

describe("waitForBuiltInServiceReady", () => {
  it("does not resolve until the lifecycle stream reports ready", async () => {
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
    const observed: string[] = [];

    const result = waitForBuiltInServiceReady(snapshots(), "Terminal", (current) =>
      observed.push(current.state),
    );
    await starting;

    releaseReady?.();
    assert.equal((await result).state, "ready");
    assert.deepEqual(observed, ["starting", "ready"]);
  });

  it("rejects when provisioning fails", async () => {
    async function* snapshots(): AsyncIterable<SshMachineService> {
      yield snapshot("starting");
      yield { ...snapshot("error"), error: "install failed" };
    }
    await assert.rejects(
      waitForBuiltInServiceReady(snapshots(), "Terminal", () => undefined),
      /install failed/,
    );
  });

  it("resolves as soon as ready without waiting for the stream to close", async () => {
    let releaseStream: (() => void) | undefined;
    const streamClosed = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* snapshots(): AsyncIterable<SshMachineService> {
      yield snapshot("starting");
      yield snapshot("ready");
      await streamClosed;
    }
    const result = await waitForBuiltInServiceReady(snapshots(), "Terminal", () => undefined);

    assert.equal(result.state, "ready");
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
