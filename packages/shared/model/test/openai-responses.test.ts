import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/openai-chat";
import {
  chatToResponse,
  createResponsesStreamTranslator,
  readResponsesOutput,
  responsesToChat,
  sanitizeOpenResponsesRequest,
} from "../src/openai-responses";

/** The `messages` a lowered Responses body produced, typed for assertions. */
function messagesOf(body: Record<string, unknown>): ChatMessage[] {
  const { chat } = responsesToChat(body);
  return chat.messages as ChatMessage[];
}

/** Event names, in order, from a block of SSE text. */
function eventNames(sse: string): string[] {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length));
}

/** Parsed `data:` payloads from a block of SSE text. */
function eventData(sse: string): Record<string, unknown>[] {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("responsesToChat", () => {
  it("lowers instructions and message items into a chat transcript", () => {
    const messages = messagesOf({
      instructions: "be terse",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    assert.deepEqual(messages, [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });

  it("maps the developer role to system (chat has no developer role)", () => {
    const [first] = messagesOf({ input: [{ role: "developer", content: "policy" }] });
    assert.equal(first?.role, "system");
  });

  it("re-attaches a prior function_call to an assistant turn", () => {
    const [first] = messagesOf({
      input: [{ type: "function_call", call_id: "c1", name: "lookup", arguments: '{"q":1}' }],
    });
    assert.equal(first?.role, "assistant");
    assert.equal(first?.content, null);
    assert.deepEqual(first?.tool_calls, [
      { id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } },
    ]);
  });

  it("keys a function_call_output back to the call it answers", () => {
    const [first] = messagesOf({
      input: [{ type: "function_call_output", call_id: "c1", output: "42" }],
    });
    assert.deepEqual(first, { role: "tool", tool_call_id: "c1", content: "42" });
  });

  it("nests flat Responses function tools and drops built-in tool types", () => {
    const { chat } = responsesToChat({
      input: [],
      tools: [
        { type: "function", name: "lookup", description: "d", parameters: { type: "object" } },
        { type: "local_shell" },
        { type: "web_search" },
      ],
      tool_choice: "auto",
    });
    assert.deepEqual(chat.tools, [
      {
        type: "function",
        function: { name: "lookup", description: "d", parameters: { type: "object" } },
      },
    ]);
    assert.equal(chat.tool_choice, "auto");
  });

  it("never forwards parallel_tool_calls (Databricks rejects unknown fields)", () => {
    const { chat } = responsesToChat({
      input: [],
      parallel_tool_calls: true,
      tools: [{ type: "function", name: "lookup" }],
    });
    assert.ok(!("parallel_tool_calls" in chat));
  });

  it("reports the streaming flag", () => {
    assert.equal(responsesToChat({ input: [] }).stream, false);
    assert.equal(responsesToChat({ input: [], stream: true }).stream, true);
  });
});

describe("chatToResponse", () => {
  it("lifts assistant text, tool calls, and usage into a response object", () => {
    const response = chatToResponse(
      {
        id: "chatcmpl-1",
        created: 1700000000,
        choices: [
          {
            message: {
              content: "done",
              tool_calls: [{ id: "c1", function: { name: "lookup", arguments: '{"q":1}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      "databricks-claude-opus-4-8",
    ) as Record<string, unknown>;

    assert.equal(response.id, "chatcmpl-1");
    assert.equal(response.status, "completed");
    assert.equal(response.model, "databricks-claude-opus-4-8");
    assert.deepEqual(response.output, [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { type: "function_call", call_id: "c1", name: "lookup", arguments: '{"q":1}' },
    ]);
    assert.deepEqual(response.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  });

  it("omits the message item when the turn was tool calls only", () => {
    const response = chatToResponse(
      { choices: [{ message: { content: null, tool_calls: [] } }] },
      "m",
    ) as { output: unknown[] };
    assert.deepEqual(response.output, []);
  });
});

describe("createResponsesStreamTranslator", () => {
  it("opens on the first chunk and closes the text run at finish", () => {
    const translator = createResponsesStreamTranslator("m", "resp-1");
    const first = translator.feed({ choices: [{ delta: { content: "he" } }] });
    assert.deepEqual(eventNames(first), [
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
    ]);

    const second = translator.feed({ choices: [{ delta: { content: "llo" } }] });
    assert.deepEqual(eventNames(second), ["response.output_text.delta"]);

    const done = translator.finish();
    assert.deepEqual(eventNames(done), [
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    // The buffered text is what the client renders as the final message.
    assert.equal(eventData(done)[0]?.text, "hello");
  });

  it("assembles argument fragments into one function_call item", () => {
    const translator = createResponsesStreamTranslator("m", "resp-1");
    translator.feed({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup" } }] } }],
    });
    translator.feed({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q' } }] } }],
    });
    translator.feed({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }],
    });

    const done = translator.finish();
    const [args] = eventData(done);
    assert.equal(args?.arguments, '{"q":1}');
    assert.ok(eventNames(done).includes("response.function_call_arguments.done"));
  });

  it("closes an open text run before opening a tool call so output stays ordered", () => {
    const translator = createResponsesStreamTranslator("m", "resp-1");
    translator.feed({ choices: [{ delta: { content: "thinking" } }] });
    const withTool = translator.feed({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f" } }] } }],
    });
    assert.deepEqual(eventNames(withTool), [
      "response.output_text.done",
      "response.output_item.done",
      "response.output_item.added",
    ]);
  });

  it("emits nothing but the lifecycle for an empty chunk", () => {
    const translator = createResponsesStreamTranslator("m", "resp-1");
    assert.deepEqual(eventNames(translator.feed({})), ["response.created"]);
    assert.deepEqual(eventNames(translator.finish()), ["response.completed"]);
  });
});

describe("readResponsesOutput", () => {
  it("prefers the flattened output_text", () => {
    const { text } = readResponsesOutput({
      output_text: "  the answer  ",
      output: [{ content: [{ text: "ignored" }] }],
    });
    assert.equal(text, "the answer");
  });

  it("falls back to joining the output items", () => {
    const { text } = readResponsesOutput({
      output: [{ content: [{ text: "one" }, { text: "two" }] }],
    });
    assert.equal(text, "one\ntwo");
  });

  it("collects url_citation annotations, deduplicated by url", () => {
    const { citations } = readResponsesOutput({
      output: [
        {
          content: [
            {
              text: "answer",
              annotations: [
                { type: "url_citation", url: "https://a.example", title: "A" },
                { type: "url_citation", url: "https://a.example", title: "A again" },
                { type: "url_citation", url: "https://b.example" },
                { type: "file_citation" },
              ],
            },
          ],
        },
      ],
    });
    assert.deepEqual(citations, [
      { url: "https://a.example", title: "A" },
      { url: "https://b.example" },
    ]);
  });

  it("returns empty results for a payload with no output", () => {
    assert.deepEqual(readResponsesOutput({}), { text: "", citations: [] });
  });
});

describe("sanitizeOpenResponsesRequest", () => {
  it("rewrites output_text content parts to input_text", () => {
    const out = sanitizeOpenResponsesRequest({
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      ],
    });
    assert.deepEqual(out.input, [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "hi" }],
      },
    ]);
  });

  it("strips redacted_thinking / thinking content parts and reasoning items", () => {
    const out = sanitizeOpenResponsesRequest({
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "not-a-valid-blob" },
            { type: "thinking", thinking: "secret" },
            { type: "output_text", text: "visible" },
          ],
        },
      ],
    });
    assert.deepEqual(out.input, [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "visible" }],
      },
    ]);
  });

  it("drops assistant turns that only carried thinking", () => {
    const out = sanitizeOpenResponsesRequest({
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "redacted_thinking", data: "x" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    assert.deepEqual(out.input, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    ]);
  });

  it("strips non-function tools", () => {
    const out = sanitizeOpenResponsesRequest({
      input: [],
      tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: {} }],
    });
    assert.deepEqual(out.tools, [{ type: "function", name: "f", parameters: {} }]);
  });
});
