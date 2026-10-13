import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshMachineService } from "@dbx-tools/shared-databricks-sandbox";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BUILT_IN_SERVICE_CONTROLS,
  BuiltInServiceLog,
  BuiltInServiceLauncher,
  InstallLogPanel,
  type BuiltInServiceLauncherProps,
  selectedBuiltInServiceLog,
  startAndOpenBuiltInService,
  waitForBuiltInServiceReady,
} from "../src/react/built-in-service-launcher.tsx";

const snapshot = (state: SshMachineService["state"]): SshMachineService => ({
  kind: "terminal",
  path: "/sandbox/terminal/machine-1",
  openUrl: "/sandbox/terminal/machine-1/",
  state,
});

async function withWindow<T>(run: () => T | Promise<T>): Promise<T> {
  const browserWindow = globalThis.window;
  globalThis.window = {
    location: { origin: "http://localhost" },
  } as Window & typeof globalThis;
  try {
    return await run();
  } finally {
    if (browserWindow) globalThis.window = browserWindow;
    else Reflect.deleteProperty(globalThis, "window");
  }
}

/** Renders one service launcher with the requested lifecycle state. */
async function renderLauncher(
  state: SshMachineService["state"],
  onSelectLogs: BuiltInServiceLauncherProps["onSelectLogs"],
  extra: Pick<BuiltInServiceLauncherProps, "logsOpen" | "onHideLogs"> = {},
): Promise<string> {
  const service = snapshot(state);
  return withWindow(() =>
    renderToStaticMarkup(
      createElement(BuiltInServiceLauncher, {
        client: {} as BuiltInServiceLauncherProps["client"],
        machine: {
          id: "machine-1",
          name: "Machine 1",
          provider: "databricks-sandbox",
          status: "running",
          expiresAt: "2026-10-14T12:00:00.000Z",
          projects: [],
          services: [service],
          canStart: false,
          canStop: true,
          canConnect: true,
        },
        kind: "terminal",
        onSnapshot: () => undefined,
        onError: () => undefined,
        onSelectLogs,
        ...extra,
      }),
    ),
  );
}

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

describe("startAndOpenBuiltInService", () => {
  it("opens the service URL only after the lifecycle stream reports ready", async () => {
    const opened: string[] = [];
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

    const result = withWindow(() =>
      startAndOpenBuiltInService({
        snapshots: snapshots(),
        label: "Terminal",
        onSnapshot: () => undefined,
        openTab: (url) => {
          opened.push(url);
          return null;
        },
      }),
    );
    await starting;
    assert.deepEqual(opened, []);

    releaseReady?.();
    assert.equal((await result).state, "ready");
    assert.deepEqual(opened, ["http://localhost/sandbox/terminal/machine-1/"]);
  });

  it("does not open a tab when install fails", async () => {
    const opened: string[] = [];
    async function* snapshots(): AsyncIterable<SshMachineService> {
      yield { ...snapshot("error"), error: "install failed" };
    }

    await assert.rejects(
      withWindow(() =>
        startAndOpenBuiltInService({
          snapshots: snapshots(),
          label: "Terminal",
          onSnapshot: () => undefined,
          openTab: (url) => {
            opened.push(url);
            return null;
          },
        }),
      ),
      /install failed/,
    );
    assert.deepEqual(opened, []);
  });
});

describe("BuiltInServiceLauncher", () => {
  it("orders service controls as stats, terminal, and desktop", () => {
    assert.deepEqual(
      BUILT_IN_SERVICE_CONTROLS.map((control) => control.kind),
      ["stats", "terminal", "desktop"],
    );
  });

  it("shows a gray status dot without log options before installation", async () => {
    const html = await renderLauncher("stopped", () => undefined);

    assert.match(html, /aria-label="Start Terminal \(Not installed\)"/);
    assert.match(html, /bg-muted-foreground\/40/);
    assert.doesNotMatch(html, /aria-label="Show Terminal logs"/);
  });

  it("puts the spinner on the log button while installing", async () => {
    const starting = await renderLauncher("starting", () => undefined);
    const error = await renderLauncher("error", () => undefined);

    assert.match(starting, /aria-label="Start Terminal \(Not installed\)"/);
    assert.match(starting, /aria-label="Show Terminal logs"/);
    assert.match(starting, /animate-spin/);
    assert.match(error, /aria-label="Start Terminal \(Unhealthy\)"/);
    assert.match(error, /aria-label="Show Terminal logs"/);
    assert.doesNotMatch(error, /animate-spin/);
  });

  it("indents the log button while logs are open", async () => {
    const ready = await renderLauncher("ready", () => undefined, {
      logsOpen: true,
      onHideLogs: () => undefined,
    });
    const starting = await renderLauncher("starting", () => undefined, {
      logsOpen: true,
      onHideLogs: () => undefined,
    });

    assert.match(ready, /aria-label="Hide Terminal logs"/);
    assert.match(ready, /aria-pressed="true"/);
    assert.match(ready, /shadow-inner/);
    assert.doesNotMatch(ready, /animate-spin/);
    assert.match(starting, /aria-pressed="true"/);
    assert.match(starting, /animate-spin/);
  });

  it("shows the installed status and log toggle only when logs can be selected", async () => {
    const installed = await renderLauncher("ready", () => undefined);
    const withoutLogs = await renderLauncher("ready", undefined);

    assert.match(installed, /aria-label="Open Terminal \(Installed\)"/);
    assert.match(installed, /bg-emerald-500/);
    assert.match(installed, /aria-label="Show Terminal logs"/);
    assert.doesNotMatch(withoutLogs, /aria-label="Show Terminal logs"/);
  });
});

describe("selectedBuiltInServiceLog", () => {
  it("returns only the selected service", () => {
    const machine = {
      id: "machine-1",
      services: [
        snapshot("starting"),
        { ...snapshot("ready"), kind: "desktop" as const },
        { ...snapshot("starting"), kind: "stats" as const, log: "installing" },
      ],
    } as Parameters<typeof selectedBuiltInServiceLog>[0];

    assert.equal(selectedBuiltInServiceLog(machine, "desktop")?.kind, "desktop");
    assert.equal(selectedBuiltInServiceLog(machine, "stats")?.kind, "stats");
    assert.equal(selectedBuiltInServiceLog(machine, "terminal")?.kind, "terminal");
    assert.equal(selectedBuiltInServiceLog(machine, undefined), undefined);
  });
});

describe("BuiltInServiceLog", () => {
  it("renders an empty starting log panel when opened", () => {
    const html = renderToStaticMarkup(
      createElement(BuiltInServiceLog, { service: snapshot("starting") }),
    );
    assert.match(html, /Terminal install logs/);
    assert.match(html, /has no recorded output/);
  });

  it("renders install logs once output arrives", () => {
    const html = renderToStaticMarkup(
      createElement(BuiltInServiceLog, {
        service: { ...snapshot("starting"), log: "downloading ttyd\n" },
      }),
    );
    assert.match(html, /Terminal install logs/);
    assert.match(html, /downloading ttyd/);
    assert.doesNotMatch(html, /aria-label="Hide Terminal logs"/);
  });
});

describe("InstallLogPanel", () => {
  it("renders a saved project install log", () => {
    const html = renderToStaticMarkup(
      createElement(InstallLogPanel, {
        label: "whiteboard",
        state: "error",
        log: "mise install failed\n",
      }),
    );
    assert.match(html, /whiteboard install logs/);
    assert.match(html, /mise install failed/);
    assert.match(html, />error</);
    assert.match(html, /aria-label="Copy whiteboard install logs"/);
    assert.match(html, /select-text/);
  });
});
