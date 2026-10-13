/** Coverage for demo server watch wrapping. */
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { demoWatchArgs } from "./run-demo.ts";

describe("demo server watch", () => {
  it("runs the server through the imported watcher by default", () => {
    const args = demoWatchArgs([]);
    assert.equal(args[0], "bun");
    assert.match(args[1] ?? "", /packages\/example\/server\/appkit-demo\/src\/server\.ts/);
  });

  it("forwards include and exclude globs into dev:watch", () => {
    const args = demoWatchArgs([
      "--watch-include",
      "packages/js/ui/**",
      "--watch-exclude",
      "**/*.md",
    ]);
    assert.deepEqual(args.slice(0, 4), [
      "--watch-include",
      "packages/js/ui/**",
      "--watch-exclude",
      "**/*.md",
    ]);
  });

  it("forwards --watch-disable into dev:watch", () => {
    assert.deepEqual(demoWatchArgs(["-d"]).slice(0, 2), ["-d", "bun"]);
  });
});
