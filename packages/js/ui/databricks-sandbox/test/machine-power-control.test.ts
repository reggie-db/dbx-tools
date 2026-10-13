import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SshMachine } from "@dbx-tools/shared-databricks-sandbox";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MachinePowerButton, machinePowerControl } from "../src/react/machine-power-control.tsx";

function machine(overrides: Partial<SshMachine>): SshMachine {
  return {
    id: "machine-1",
    name: "Machine 1",
    provider: "databricks-sandbox",
    status: "stopped",
    expiresAt: "2026-10-14T12:00:00.000Z",
    projects: [],
    services: [],
    canStart: true,
    canStop: false,
    canConnect: true,
    ...overrides,
  };
}

describe("machinePowerControl", () => {
  it("shows Start when the machine can start", () => {
    assert.deepEqual(machinePowerControl(machine({ status: "stopped", canStart: true })), {
      action: "start",
      enabled: true,
    });
  });

  it("shows Stop when the machine is running", () => {
    assert.deepEqual(
      machinePowerControl(machine({ status: "running", canStart: false, canStop: true })),
      { action: "stop", enabled: true },
    );
  });

  it("shows a disabled Stop while starting", () => {
    assert.deepEqual(
      machinePowerControl(machine({ status: "starting", canStart: false, canStop: true })),
      { action: "stop", enabled: false },
    );
  });

  it("shows a disabled Start while stopping", () => {
    assert.deepEqual(
      machinePowerControl(machine({ status: "stopping", canStart: false, canStop: true })),
      { action: "start", enabled: false },
    );
  });
});

function renderPower(overrides: Partial<SshMachine>): string {
  return renderToStaticMarkup(
    createElement(MachinePowerButton, {
      machine: machine(overrides),
      onStart: () => undefined,
      onStop: () => undefined,
    }),
  );
}

function isDisabled(html: string): boolean {
  const openTag = html.slice(0, Math.max(html.indexOf(">"), 0));
  return /\sdisabled(?:=""|=''|(?=\s|>|$))/.test(openTag);
}

describe("MachinePowerButton", () => {
  it("renders an enabled Start when stopped", () => {
    const html = renderPower({ status: "stopped", canStart: true, canStop: false });
    assert.match(html, /aria-label="Start Machine 1"/);
    assert.equal(isDisabled(html), false);
  });

  it("renders an enabled Stop when running", () => {
    const html = renderPower({ status: "running", canStart: false, canStop: true });
    assert.match(html, /aria-label="Stop Machine 1"/);
    assert.match(html, />Stop</);
    assert.equal(isDisabled(html), false);
  });

  it("omits visible labels when iconOnly", () => {
    const html = renderToStaticMarkup(
      createElement(MachinePowerButton, {
        machine: machine({ status: "running", canStart: false, canStop: true }),
        iconOnly: true,
        onStart: () => undefined,
        onStop: () => undefined,
      }),
    );
    assert.match(html, /aria-label="Stop Machine 1"/);
    assert.doesNotMatch(html, />Stop</);
  });

  it("renders a disabled spinning Stop while starting", () => {
    const html = renderPower({ status: "starting", canStart: false, canStop: true });
    assert.match(html, /aria-label="Stop Machine 1"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /title="Starting"/);
    assert.equal(isDisabled(html), true);
  });

  it("renders a disabled spinning Start while stopping", () => {
    const html = renderPower({ status: "stopping", canStart: false, canStop: true });
    assert.match(html, /aria-label="Start Machine 1"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /title="Stopping"/);
    assert.equal(isDisabled(html), true);
  });
});
