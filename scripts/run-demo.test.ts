/** Coverage for demo server watch wrapping. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { devWatch } from "@dbx-tools/projen";
import { demoClientCommand, demoServerCommand, serverWatchDisabled } from "./run-demo.ts";

describe("demo server watch", () => {
  const previous = process.env[devWatch.SERVER_WATCH_DISABLED_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[devWatch.SERVER_WATCH_DISABLED_ENV];
    else process.env[devWatch.SERVER_WATCH_DISABLED_ENV] = previous;
  });

  it("wraps the server with dev:watch by default", () => {
    delete process.env[devWatch.SERVER_WATCH_DISABLED_ENV];
    assert.equal(serverWatchDisabled(), false);
    assert.match(demoServerCommand(), new RegExp(` ${devWatch.DEV_WATCH_TASK} bun `));
  });

  it("skips dev:watch when SERVER_WATCH_DISABLED is set", () => {
    process.env[devWatch.SERVER_WATCH_DISABLED_ENV] = "1";
    assert.equal(serverWatchDisabled(), true);
    assert.doesNotMatch(demoServerCommand(), new RegExp(` ${devWatch.DEV_WATCH_TASK} `));
  });

  it("keeps the client HMR task independent of server watching", () => {
    process.env[devWatch.SERVER_WATCH_DISABLED_ENV] = "1";
    assert.match(demoClientCommand(), /demo-appkit-app'?(?:\s|$)/);
    assert.match(demoClientCommand(), / dev$/);
    assert.doesNotMatch(demoClientCommand(), new RegExp(devWatch.DEV_WATCH_TASK));
  });
});
