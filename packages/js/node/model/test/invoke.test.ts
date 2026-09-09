import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatCompletionsUrl,
  invocationsUrl,
  isResponsesOnly,
  openResponsesUrl,
  responsesUpstreamUrl,
  responsesUrl,
} from "../src/invoke.ts";

describe("Model Serving invocation URLs", () => {
  it("encodes endpoint ids in the invocations URL", () => {
    assert.equal(
      invocationsUrl("https://workspace.example.com/", "team/model name"),
      "https://workspace.example.com/serving-endpoints/team%2Fmodel%20name/invocations",
    );
  });

  it("builds shared serving paths", () => {
    assert.equal(
      responsesUrl("https://workspace.example.com"),
      "https://workspace.example.com/serving-endpoints/responses",
    );
    assert.equal(
      openResponsesUrl("https://workspace.example.com/"),
      "https://workspace.example.com/serving-endpoints/open-responses",
    );
    assert.equal(
      chatCompletionsUrl("https://workspace.example.com/"),
      "https://workspace.example.com/serving-endpoints/chat/completions",
    );
  });

  it("selects the provider-compatible Responses path", () => {
    assert.equal(
      responsesUpstreamUrl("https://workspace.example.com/", "databricks-gpt-5"),
      "https://workspace.example.com/serving-endpoints/responses",
    );
    assert.equal(
      responsesUpstreamUrl("https://workspace.example.com/", "databricks-claude-sonnet-4-6"),
      "https://workspace.example.com/serving-endpoints/open-responses",
    );
  });

  it("identifies endpoints that require native Responses", () => {
    assert.equal(isResponsesOnly("databricks-gpt-5-3"), false);
    assert.equal(isResponsesOnly("databricks-gpt-5-4"), true);
    assert.equal(isResponsesOnly("databricks-gpt-6"), true);
    assert.equal(isResponsesOnly("databricks-gpt-6-0"), true);
    assert.equal(isResponsesOnly("databricks-gpt-oss-120b"), false);
    assert.equal(isResponsesOnly("databricks-gpt-5-3-codex"), true);
    assert.equal(isResponsesOnly("databricks-claude-sonnet-4-6"), false);
  });
});
