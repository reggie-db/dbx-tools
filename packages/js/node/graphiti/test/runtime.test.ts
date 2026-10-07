import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphitiOpenApi, runGraphiti, startGraphitiRuntime } from "../src/runtime.ts";

describe("Graphiti runtime", () => {
  it("exposes only option-driven lifecycle entry points", () => {
    assert.equal(typeof startGraphitiRuntime, "function");
    assert.equal(typeof runGraphiti, "function");
    assert.equal(typeof graphitiOpenApi, "function");
  });
});
