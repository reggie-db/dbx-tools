import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appkitServerConfig } from "@databricks/appkit/tsdown";

import researcher from "./fixtures/native-agent/server/agents/researcher/agent.ts";

const fixtureRoot = join(import.meta.dirname, "fixtures/native-agent");

describe("native AppKit code-agent example", () => {
  it("uses a branded definition with an exact model and curated skill", () => {
    assert.equal(researcher.name, "Researcher");
    assert.equal(researcher.default, true);
    assert.equal(researcher.model, "databricks-gpt-6-1-sol");
    assert.deepEqual(researcher.skills, ["research-policy"]);
    assert.equal(
      existsSync(join(fixtureRoot, "server/agents/skills/research-policy/SKILL.md")),
      true,
    );
  });

  it("uses AppKit's server preset for source and compiled agent entries", () => {
    const config = appkitServerConfig({}, { cwd: fixtureRoot });
    assert.deepEqual(config.entry, ["server/server.ts", "server/agents/*/agent.ts"]);
    assert.equal(config.clean, true);
    assert.equal(config.outExtensions?.({ format: "esm" } as never).js, ".js");
  });
});
