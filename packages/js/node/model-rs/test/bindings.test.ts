import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chatToolReasoningEffort,
  isResponsesOnly,
  modelServingApi,
  ModelServingApi,
  ReasoningEffort,
} from "../index.ts";

describe("model Rust bindings", () => {
  it("exposes inference protocol selection", () => {
    assert.equal(modelServingApi("databricks-gpt-6-astra"), ModelServingApi.Responses);
    assert.equal(modelServingApi("databricks-gpt-oss-120b"), ModelServingApi.Chat);
    assert.equal(isResponsesOnly("databricks-gpt-5-6-sol"), true);
  });

  it("exposes Chat tool reasoning policy", () => {
    assert.equal(chatToolReasoningEffort("databricks-gpt-5-6-sol"), ReasoningEffort.None);
    assert.equal(chatToolReasoningEffort("databricks-gpt-5-5-pro"), undefined);
  });
});
