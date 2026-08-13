import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { polygotTest } from "@dbx-tools/test-polyglot/polyglot";

await polygotTest(
  () => import("../index.ts"),
  "invoke",
  (implementation, language) => {
    describe(`Model Serving invocation URLs (${language})`, () => {
      it("encodes endpoint ids in the invocations URL", () => {
        assert.equal(
          implementation.invocationsUrl("https://workspace.example.com/", "team/model name"),
          "https://workspace.example.com/serving-endpoints/team%2Fmodel%20name/invocations",
        );
      });

      it("builds shared serving paths", () => {
        assert.equal(
          implementation.responsesUrl("https://workspace.example.com"),
          "https://workspace.example.com/serving-endpoints/responses",
        );
        assert.equal(
          implementation.openResponsesUrl("https://workspace.example.com/"),
          "https://workspace.example.com/serving-endpoints/open-responses",
        );
        assert.equal(
          implementation.chatCompletionsUrl("https://workspace.example.com/"),
          "https://workspace.example.com/serving-endpoints/chat/completions",
        );
      });

      it("selects the provider-compatible Responses path", () => {
        assert.equal(
          implementation.responsesUpstreamUrl("https://workspace.example.com/", "databricks-gpt-5"),
          "https://workspace.example.com/serving-endpoints/responses",
        );
        assert.equal(
          implementation.responsesUpstreamUrl(
            "https://workspace.example.com/",
            "databricks-claude-sonnet-4-6",
          ),
          "https://workspace.example.com/serving-endpoints/open-responses",
        );
      });

      it("identifies endpoints that require native Responses", () => {
        assert.equal(implementation.isResponsesOnly("databricks-gpt-5-3"), false);
        assert.equal(implementation.isResponsesOnly("databricks-gpt-5-4"), true);
        assert.equal(implementation.isResponsesOnly("databricks-gpt-6"), true);
        assert.equal(implementation.isResponsesOnly("databricks-gpt-6-0"), true);
        assert.equal(implementation.isResponsesOnly("databricks-gpt-oss-120b"), false);
        assert.equal(implementation.isResponsesOnly("databricks-gpt-5-3-codex"), true);
        assert.equal(implementation.isResponsesOnly("databricks-claude-sonnet-4-6"), false);
      });
    });
  },
);
