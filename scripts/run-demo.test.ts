/** Coverage for demo server watch wrapping. */
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { devWatch } from "@dbx-tools/projen";
import { demoClientCommand, demoServerCommand } from "./run-demo.ts";

describe("demo server watch", () => {
  it("wraps the server with dev:watch by default", () => {
    assert.match(demoServerCommand([]), new RegExp(` ${devWatch.DEV_WATCH_TASK} bun `));
    assert.doesNotMatch(demoServerCommand([]), /--watch-include|--watch-exclude/);
  });

  it("forwards include and exclude globs into dev:watch", () => {
    const command = demoServerCommand([
      "--watch-include",
      "packages/js/ui/**",
      "--watch-exclude",
      "**/*.md",
    ]);
    assert.match(command, new RegExp(` ${devWatch.DEV_WATCH_TASK} `));
    assert.match(command, /--watch-include" "packages\/js\/ui\/\*\*"/);
    assert.match(command, /--watch-exclude" "\*\*\/\*\.md"/);
  });

  it("keeps the client HMR task independent of server watching", () => {
    assert.match(demoClientCommand(), /demo-appkit-app'?(?:\s|$)/);
    assert.match(demoClientCommand(), / dev$/);
    assert.doesNotMatch(demoClientCommand(), new RegExp(devWatch.DEV_WATCH_TASK));
  });
});
