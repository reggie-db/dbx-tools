import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { log } from "../index.ts";

describe("log", () => {
  it("keeps the shared logger free of optional bare imports", async () => {
    const source = await readFile(new URL("../src/log.ts", import.meta.url), "utf8");

    assert.doesNotMatch(source, /from\s+["']consola["']|import\s*\(.*["']consola["']/s);
  });

  it("maps convenience levels onto the logger", () => {
    const logger = log.logger("test/log");

    assert.equal(typeof logger.success, "function");
    assert.equal(typeof logger.start, "function");
  });
});
