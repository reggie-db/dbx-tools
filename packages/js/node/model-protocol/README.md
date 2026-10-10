# @dbx-tools/model-protocol

Shared Vercel AI SDK providers and protocol transforms for Databricks model traffic.

Use this package when a Node service needs to:

- construct a request-scoped AI SDK model for Databricks Chat Completions, Responses, or Anthropic Messages;
- translate OpenAI or Anthropic gateway messages to and from AI SDK messages;
- normalize Databricks Chat Completions request and response wire shapes.

Model discovery and capability policy remain in `@dbx-tools/model`. Browser-safe model and gateway contracts remain in `@dbx-tools/shared-model` and `@dbx-tools/shared-model-gateway`.
