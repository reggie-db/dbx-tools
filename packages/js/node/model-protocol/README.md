# @dbx-tools/model-protocol

Shared Vercel AI SDK providers and protocol transforms for Databricks model traffic.

Use this package when a Node service needs to:

- construct a request-scoped AI SDK model for Databricks Chat Completions, Responses, or Anthropic Messages;
- translate OpenAI or Anthropic gateway messages to and from AI SDK messages;
- normalize Databricks Chat Completions request and response wire shapes.

Model discovery and capability policy remain in `@dbx-tools/model`. Browser-safe model and gateway contracts remain in `@dbx-tools/shared-model` and `@dbx-tools/shared-model-gateway`.

## Invoke A Databricks Model

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

Use `chat`, `responses`, or `anthropic` according to the model-owned protocol
selection. The chat provider applies Databricks serving-wire repairs through a
provider-local `fetch`; it does not patch `globalThis.fetch`.

## Translate A Gateway Request

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
