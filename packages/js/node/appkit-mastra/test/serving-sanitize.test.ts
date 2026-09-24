import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  rewriteServingResponseBody,
  rewriteServingResponseStream,
} from "../src/serving-sanitize.ts";

/**
 * Trimmed copy of a real Databricks-hosted Gemini reply: `content` is the
 * Gemini-native parts array, and the text part also carries the signed
 * `thoughtSignature` the model returns alongside it.
 */
const geminiPartsResponse = {
  model: "gemini-3.1-flash-lite",
  choices: [
    {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Fuel Mart Weekly Sales Summary", thoughtSignature: "AY89a18" },
        ],
      },
      index: 0,
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2098, completion_tokens: 5, total_tokens: 2201 },
  object: "chat.completion",
};

describe("serving response sanitize", () => {
  it("flattens Gemini's content parts to the string the AI SDK expects", () => {
    const result = JSON.parse(rewriteServingResponseBody(JSON.stringify(geminiPartsResponse)));
    assert.equal(result.choices[0].message.content, "Fuel Mart Weekly Sales Summary");
  });

  it("preserves every sibling field while rewriting content", () => {
    const result = JSON.parse(rewriteServingResponseBody(JSON.stringify(geminiPartsResponse)));
    assert.equal(result.choices[0].finish_reason, "stop");
    assert.equal(result.choices[0].message.role, "assistant");
    assert.deepEqual(result.usage, geminiPartsResponse.usage);
    assert.equal(result.model, "gemini-3.1-flash-lite");
  });

  it("joins multiple text parts and ignores non-text ones", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "Fuel Mart " },
              { type: "image", image_url: "https://example.invalid/x.png" },
              { type: "text", text: "Sales" },
            ],
          },
        },
      ],
    });
    const result = JSON.parse(rewriteServingResponseBody(body));
    assert.equal(result.choices[0].message.content, "Fuel Mart Sales");
  });

  it("flattens a parts array holding no text to an empty string", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: [{ thoughtSignature: "AY89" }] }, finish_reason: "stop" }],
    });
    const result = JSON.parse(rewriteServingResponseBody(body));
    assert.equal(result.choices[0].message.content, "");
    assert.equal(result.choices[0].finish_reason, "stop");
  });

  it("flattens a single content part like a one-item array", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: { type: "text", text: "KPI summary" } } }],
    });
    const result = JSON.parse(rewriteServingResponseBody(body));
    assert.equal(result.choices[0].message.content, "KPI summary");
  });

  it("returns a compliant OpenAI response byte-identical", () => {
    const body = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "already a string" } }],
    });
    assert.equal(rewriteServingResponseBody(body), body);
  });

  it("leaves a non-JSON or choice-less body untouched", () => {
    assert.equal(rewriteServingResponseBody("not json"), "not json");
    assert.equal(
      rewriteServingResponseBody('{"error_code":"BAD_REQUEST"}'),
      '{"error_code":"BAD_REQUEST"}',
    );
  });

  it("repairs every choice when the provider returns more than one", () => {
    const body = JSON.stringify({
      choices: [
        { message: { content: [{ type: "text", text: "first" }] } },
        { message: { content: [{ type: "text", text: "second" }] } },
      ],
    });
    const result = JSON.parse(rewriteServingResponseBody(body));
    assert.deepEqual(
      result.choices.map((c: { message: { content: string } }) => c.message.content),
      ["first", "second"],
    );
  });

  it("flattens Claude reasoning and text arrays across split SSE chunks", async () => {
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: "", signature: "" }],
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: { type: "text", text: "KPI summary" } } }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(sse);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17, 73));
        controller.enqueue(bytes.slice(73));
        controller.close();
      },
    });

    const rewritten = await new Response(rewriteServingResponseStream(body)).text();
    const data = rewritten
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));

    assert.equal(data[0].choices[0].delta.content, "");
    assert.equal(data[0].choices[0].delta.role, "assistant");
    assert.equal(data[1].choices[0].delta.content, "KPI summary");
    assert.ok(rewritten.endsWith("data: [DONE]\n\n"));
  });
});
