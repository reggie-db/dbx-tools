# @dbx-tools/model-protocol

Construct Vercel AI SDK ProviderV4 models for Databricks endpoints and translate
gateway traffic between supported model protocols.

## Invoke a Databricks model

Construct the AI SDK model after resolving the endpoint protocol and fresh
authentication headers for the current request:

```ts
import { createDatabricksLanguageModel } from "@dbx-tools/model-protocol/provider";
import { generateText } from "ai";

const model = createDatabricksLanguageModel({
  host: process.env.DATABRICKS_HOST!,
  modelId: "databricks-gpt-5-6-sol",
  protocol: "responses",
  headers: { authorization: `Bearer ${process.env.DATABRICKS_TOKEN}` },
});

const result = await generateText({ model, prompt: "Summarize the incident." });
console.log(result.text);
```

Use this package when a Node service needs to:

- construct a request-scoped AI SDK model for Databricks Chat Completions,
  Responses, or Anthropic Messages.
- translate OpenAI or Anthropic gateway messages to and from AI SDK messages.
- normalize Databricks Chat Completions request and response wire shapes.

Model discovery and capability policy remain in `@dbx-tools/model`.
Browser-safe model and gateway contracts remain in
[@dbx-tools/shared-model](../../shared/model) and
[@dbx-tools/shared-model-gateway](../../shared/model-gateway).

Use `chat`, `responses`, or `anthropic` according to the model-owned protocol
selection. The chat provider applies Databricks serving-wire repairs through a
provider-local `fetch`. It does not patch `globalThis.fetch`.

## Translate a gateway request

Decode an OpenAI or Anthropic request into AI SDK messages and encode the
completed generation back into the caller's protocol:

```ts
import { decodeGatewayRequest } from "@dbx-tools/model-protocol/gateway-decode";
import { encodeGatewayResponse } from "@dbx-tools/model-protocol/gateway-encode";
import { createDatabricksLanguageModel } from "@dbx-tools/model-protocol/provider";
import { generateText } from "ai";

const protocol = "openai-chat" as const;
const decoded = decodeGatewayRequest(protocol, {
  messages: [{ role: "user", content: "Hello" }],
});
const model = createDatabricksLanguageModel({
  host: process.env.DATABRICKS_HOST!,
  modelId: "databricks-gpt-5-6-sol",
  protocol: "responses",
  headers: { authorization: `Bearer ${process.env.DATABRICKS_TOKEN}` },
});
const generated = await generateText({ model, ...decoded });

const response = encodeGatewayResponse(protocol, "databricks-gpt-5-6-sol", {
  text: generated.text,
  toolCalls: generated.toolCalls,
  usage: generated.usage,
  finishReason: generated.finishReason,
});
```

Use `encodeGatewayStream()` instead when forwarding `streamText().fullStream`.
The decoder and encoders share tool-call, reasoning, usage, and finish-reason
handling between Mastra and the model gateway.

## Protocol coverage and limits

The provider side supports Databricks Chat Completions, Responses, and
Anthropic Messages. The gateway decoder and encoders support OpenAI Chat
Completions, OpenAI Responses, and Anthropic Messages for buffered and
streaming text and function-tool traffic. The model gateway sends embeddings
directly and doesn't translate them through this package.

Fallback translation preserves text, function tools, tool results, reasoning
events, token usage, and finish reasons. It doesn't implement stateful
Responses features such as `previous_response_id`, `store: true`, or
`background: true`.

The Chat provider's request-scoped fetch removes unsupported fields, applies
GPT 5.6 tool-call reasoning compatibility, strips provider reasoning blocks
that can't be replayed, repairs assistant prefill after tool results, and
flattens array-valued response content while preserving returned thinking as
AI SDK reasoning events. It doesn't modify `globalThis.fetch`.
