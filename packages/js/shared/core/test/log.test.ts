import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { log } from "../index.ts";
import { logActiveLevel, logLevelEnabled } from "../src/bindings.ts";

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

  it("writes informational logs to stdout and warnings to stderr", () => {
    const moduleUrl = new URL("../src/log.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import { logger } from ${JSON.stringify(moduleUrl)}; const split = logger("split"); split.info("out"); split.warn("err");`,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /INFO \[split\] out/);
    assert.doesNotMatch(result.stdout, /WARN \[split\] err/);
    assert.match(result.stderr, /WARN \[split\] err/);
    assert.doesNotMatch(result.stderr, /INFO \[split\] out/);
  });

  it("exposes the active threshold through binding-safe functions", () => {
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";

    try {
      assert.equal(logActiveLevel(), "warn");
      assert.equal(logLevelEnabled("info"), false);
      assert.equal(logLevelEnabled("error"), true);
    } finally {
      if (originalLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalLevel;
    }
  });
});
