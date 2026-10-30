import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDatabricksLanguageModel } from "@dbx-tools/model-protocol";
import { MessageList } from "@mastra/core/agent";
import type { ProcessInputStepResult } from "@mastra/core/processors";
import { generateText } from "ai";

import {
  buildResponsesProviderOptionsProcessor,
  stripForeignResponsesState,
} from "../src/processors.ts";

describe("Responses provider options", () => {
  it("requests visible reasoning by default for every Responses provider namespace", () => {
    const processor = buildResponsesProviderOptionsProcessor(true);
    const result = processor.processInputStep!({
      model: { provider: "databricks.responses", modelId: "model-a" },
      providerOptions: { databricks: { reasoningEffort: "high" } },
    } as never);

    assert.deepEqual(result, {
      providerOptions: {
        databricks: {
          store: false,
          reasoningSummary: "auto",
          reasoningEffort: "high",
        },
      },
    });
  });

  it("preserves an explicit summary setting and enforces stateless replay", () => {
    const processor = buildResponsesProviderOptionsProcessor(true);
    const result = processor.processInputStep!({
      model: { provider: "openai.responses", modelId: "model-a" },
      providerOptions: { openai: { store: true, reasoningSummary: "detailed" } },
    } as never);

    assert.deepEqual(result, {
      providerOptions: {
        openai: {
          store: false,
          reasoningSummary: "detailed",
        },
      },
    });
  });

  it("omits summary output when reasoning emission is disabled", () => {
    const processor = buildResponsesProviderOptionsProcessor(false);
    const result = processor.processInputStep!({
      model: { provider: "openai.responses", modelId: "model-a" },
      providerOptions: { openai: { reasoningSummary: "detailed", reasoningEffort: "low" } },
    } as never);

    assert.deepEqual(result, {
      providerOptions: {
        openai: {
          store: false,
          reasoningEffort: "low",
        },
      },
    });
  });

  it("leaves non-Responses protocols on their native reasoning behavior", () => {
    const processor = buildResponsesProviderOptionsProcessor(true);
    assert.equal(
      processor.processInputStep!({
        model: { provider: "openai.chat", modelId: "model-a" },
      } as never),
      undefined,
    );
  });

  it("serializes the default summary into the Responses request", async () => {
    let received: Request | undefined;
    const model = createDatabricksLanguageModel({
      modelId: "model-a",
      protocol: "responses",
      providerName: "databricks",
      host: "https://example.cloud.databricks.com",
      headers: { authorization: "Bearer test" },
      fetch: async (input, init) => {
        received = new Request(input, init);
        return Response.json({ error: { message: "stop after request capture" } }, { status: 400 });
      },
    });
    const result = buildResponsesProviderOptionsProcessor(true).processInputStep!({
      model,
    } as never) as ProcessInputStepResult;

    assert.ok(result.providerOptions);
    await assert.rejects(
      generateText({ model, prompt: "Explain the result.", providerOptions: result.providerOptions }),
    );
    assert.ok(received);
    const body = JSON.parse(await received.clone().text()) as Record<string, unknown>;
    assert.deepEqual(body.reasoning, { summary: "auto" });
  });
});

describe("Responses model history compatibility", () => {
  it("removes only model-bound state from a different concrete model", () => {
    const messageList = new MessageList()
      .add(
        {
          id: "assistant-a",
          role: "assistant",
          metadata: { modelId: "model-a" },
          parts: [
            {
              type: "reasoning",
              text: "Model A reasoning",
              providerMetadata: {
                openai: { itemId: "rs-a", reasoningEncryptedContent: "encrypted-a" },
              },
            },
            {
              type: "text",
              text: "Answer from A",
              providerMetadata: { openai: { itemId: "msg-a" } },
            },
          ],
        },
        "memory",
      )
      .add(
        {
          id: "assistant-b",
          role: "assistant",
          metadata: { modelId: "model-b" },
          parts: [
            {
              type: "reasoning",
              text: "Model B reasoning",
              providerMetadata: {
                openai: { itemId: "rs-b", reasoningEncryptedContent: "encrypted-b" },
              },
            },
          ],
        },
        "memory",
      );
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Model A reasoning",
            providerOptions: {
              openai: { itemId: "rs-a", reasoningEncryptedContent: "encrypted-a" },
            },
          },
          {
            type: "text",
            text: "Answer from A",
            providerOptions: { openai: { itemId: "msg-a", stable: "keep" } },
          },
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "lookup",
            input: {},
            providerOptions: { openai: { itemId: "fc-a", resultItemId: "msg-a" } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Model B reasoning",
            providerOptions: {
              openai: { itemId: "rs-b", reasoningEncryptedContent: "encrypted-b" },
            },
          },
        ],
      },
    ];

    const result = stripForeignResponsesState.applyToPrompt!({
      prompt: prompt as never,
      model: { provider: "openai.responses", modelId: "model-b" },
      messageList,
    });

    assert.deepEqual(result, [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Answer from A",
            providerOptions: { openai: { stable: "keep" } },
          },
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "lookup",
            input: {},
            providerOptions: { openai: { itemId: "fc-a" } },
          },
        ],
      },
      prompt[1],
    ]);
  });

  it("retains compatible state when Smart Router selects the same model", () => {
    const messageList = new MessageList().add(
      {
        id: "assistant-a",
        role: "assistant",
        metadata: { modelId: "model-a" },
        parts: [
          {
            type: "reasoning",
            text: "Reasoning",
            providerMetadata: {
              openai: { itemId: "rs-a", reasoningEncryptedContent: "encrypted-a" },
            },
          },
        ],
      },
      "memory",
    );
    const prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Reasoning",
            providerOptions: {
              openai: { itemId: "rs-a", reasoningEncryptedContent: "encrypted-a" },
            },
          },
        ],
      },
    ];

    assert.equal(
      stripForeignResponsesState.applyToPrompt!({
        prompt: prompt as never,
        model: { provider: "openai.responses", modelId: "model-a" },
        messageList,
      }),
      undefined,
    );
  });
});
