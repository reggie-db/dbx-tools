import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeDatabricksAIToolsOption,
  provisionDatabricksAITools,
} from "../src/databricks-aitools.ts";

const BOGUS_CLI = "definitely-not-a-real-databricks-cli";

describe("normalizeDatabricksAIToolsOption", () => {
  it("returns undefined when off", () => {
    assert.equal(normalizeDatabricksAIToolsOption(undefined), undefined);
    assert.equal(normalizeDatabricksAIToolsOption(false), undefined);
  });

  it("maps true to require mode", () => {
    assert.deepEqual(normalizeDatabricksAIToolsOption(true), { mode: "require" });
  });

  it('maps "auto" to auto mode', () => {
    assert.deepEqual(normalizeDatabricksAIToolsOption("auto"), { mode: "auto" });
  });

  it("defaults an options bag to auto mode and preserves fields", () => {
    const normalized = normalizeDatabricksAIToolsOption({
      skills: ["databricks-core"],
      experimental: true,
    });
    assert.equal(normalized?.mode, "auto");
    assert.deepEqual(normalized?.skills, ["databricks-core"]);
    assert.equal(normalized?.experimental, true);
  });

  it("keeps an explicit mode over the default", () => {
    assert.equal(normalizeDatabricksAIToolsOption({ mode: "require" })?.mode, "require");
  });
});

describe("provisionDatabricksAITools", () => {
  it("returns an empty result when disabled", async () => {
    assert.deepEqual(await provisionDatabricksAITools(undefined), { localSkillPaths: [] });
    assert.deepEqual(await provisionDatabricksAITools(false), { localSkillPaths: [] });
  });

  it("auto mode logs and moves on when the CLI is unavailable", async () => {
    const result = await provisionDatabricksAITools({ mode: "auto", cli: BOGUS_CLI });
    assert.deepEqual(result, { localSkillPaths: [] });
  });

  it("require mode fails when the CLI is unavailable", async () => {
    await assert.rejects(
      provisionDatabricksAITools({ mode: "require", cli: BOGUS_CLI }),
      /Databricks AI Tools required|failed to provision/,
    );
  });

  it("require mode with failOnError:false skips instead of throwing", async () => {
    const result = await provisionDatabricksAITools({
      mode: "require",
      cli: BOGUS_CLI,
      failOnError: false,
    });
    assert.deepEqual(result, { localSkillPaths: [] });
  });
});
