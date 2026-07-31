import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  normalizeDatabricksAIToolsOption,
  provisionDatabricksAITools,
} from "../src/databricks-aitools.ts";

const INSTALLED_TREE = join(homedir(), ".databricks", "aitools", "skills");
const treeExists = existsSync(INSTALLED_TREE);
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

  it("auto mode with a bogus CLI never throws", async () => {
    const result = await provisionDatabricksAITools({
      mode: "auto",
      refresh: true,
      cli: BOGUS_CLI,
    });
    assert.ok(Array.isArray(result.localSkillPaths));
  });

  it("require mode with failOnError:false always skips instead of throwing", async () => {
    // With refresh forcing a CLI fetch and a bogus CLI, the fetch fails; the
    // installed-tree fallback may still supply paths, but it must never throw.
    const result = await provisionDatabricksAITools({
      mode: "require",
      refresh: true,
      cli: BOGUS_CLI,
      failOnError: false,
    });
    assert.ok(Array.isArray(result.localSkillPaths));
  });

  it("reuses the installed tree when present (no refresh)", async (t) => {
    if (!treeExists) return t.skip("no installed aitools tree on this machine");
    const result = await provisionDatabricksAITools("auto");
    assert.equal(result.source, "installed");
    assert.deepEqual(result.localSkillPaths, [INSTALLED_TREE]);
  });

  it("require mode fails when nothing can supply skills", async (t) => {
    if (treeExists) {
      return t.skip("installed tree present; require mode is satisfied by it");
    }
    await assert.rejects(
      provisionDatabricksAITools({ mode: "require", refresh: true, cli: BOGUS_CLI }),
      /Databricks AI Tools|failed to provision/,
    );
  });
});
