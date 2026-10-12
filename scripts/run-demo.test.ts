/** Coverage for demo server watch wrapping. */
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { devWatch } from "@dbx-tools/projen";
import { demoServerCommand } from "./run-demo.ts";

describe("demo server watch", () => {
  it("wraps the server with dev:watch by default", () => {
    const command = demoServerCommand([]);
    const task = command.indexOf(devWatch.DEV_WATCH_TASK);
    assert.ok(task > 0);
    assert.equal(command[task + 1], "bun");
    assert.ok(
      !command.some((part) => /--watch-include|--watch-exclude|--watch-disable/.test(part)),
    );
  });

  it("forwards include and exclude globs into dev:watch", () => {
    const command = demoServerCommand([
      "--watch-include",
      "packages/js/ui/**",
      "--watch-exclude",
      "**/*.md",
    ]);
    const task = command.indexOf(devWatch.DEV_WATCH_TASK);
    assert.ok(task > 0);
    assert.deepEqual(command.slice(task + 1, task + 5), [
      "--watch-include",
      "packages/js/ui/**",
      "--watch-exclude",
      "**/*.md",
    ]);
  });

  it("forwards --watch-disable into dev:watch", () => {
    const command = demoServerCommand(["-d"]);
    assert.ok(command.includes(devWatch.DEV_WATCH_TASK));
    assert.ok(command.includes("--watch-disable"));
  });
});
