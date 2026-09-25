# Mastra Release Review

Status: Complete

## Dependency Update

The workspace now uses the newest coherent stable Mastra release set available
through the configured corporate mirror:

- `@mastra/core` 1.67.0
- `@mastra/ai-sdk` 1.10.3
- `@mastra/express` 1.5.11
- `@mastra/fastembed` 1.3.1
- `@mastra/mcp` 1.18.0
- `@mastra/memory` 1.30.0
- `@mastra/observability` 1.17.8
- `@mastra/otel-bridge` 1.5.8
- `@mastra/pg` 1.25.0
- `@mastra/client-js` 1.46.0

Newer public releases were not selected because the local mirror does not yet
carry their matching package family. The selected client depends exactly on
core 1.67.0, and the server, MCP, memory, and Postgres packages accept that
core version.

## Custom Surface Review

The upgraded packages do not fully replace any dbx-tools compatibility surface:

- `ProviderHistoryCompat` is opt-in and repairs cross-provider history,
  provider-owned tool ids, and selected signed-reasoning cases. It does not
  normalize Databricks array-valued Chat Completions content, add Astra's
  tool-compatible reasoning option, or repair the hosted Claude tool-result
  prefill ordering handled by `serving-sanitize.ts`.
- Client 1.46.0 still omits per-call abort signals from `stream()` and tool
  approval methods, and those methods do not accept per-call routing headers.
  The direct stream transport remains necessary for concurrent threads,
  per-turn model selection, isolated cancellation, and approval continuation.
- Mastra's subscription-native queue and approval APIs are experimental and
  do not replace the existing concurrent-thread and explicit steering
  semantics.
- Mastra workspace and sandbox improvements extend the generic provider
  contracts. The Databricks Sandbox REST adapter, user-scoped reuse, and Monty
  fallback remain product-specific implementations.
- The AppKit request-context, scoped route, history, thread, storage migration,
  and observability adapters continue to enforce Databricks identity and
  deployment behavior that stock Mastra does not own.

All Mastra-dependent packages compile against the upgraded set, and their
focused test suites pass.
