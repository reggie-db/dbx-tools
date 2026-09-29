# `@dbx-tools/model-rs`

Generated Node bindings for the pure model-routing and capability policy owned
by the `dbx-tools-model` Rust crate.

```ts
import {
  chatToolReasoningEffort,
  modelServingApi,
  ModelServingApi,
  ReasoningEffort,
} from "@dbx-tools/model-rs";

const api = modelServingApi("databricks-gpt-6-astra");
const effort = chatToolReasoningEffort("databricks-gpt-5-6-sol");

api === ModelServingApi.Responses;
effort === ReasoningEffort.None;
```

Key exports:

- `modelServingApi` / `isResponsesOnly` select Chat Completions or native
  Responses without duplicating version thresholds in TypeScript.
- `chatToolReasoningEffort` returns the effort required by a tool-bearing Chat
  Completions request. GPT 5.6 currently requires `none`.
- `reasoningEffortsByFamily` reports the accepted effort vocabulary.
- `supportsToolsByFamily` applies the conservative complete-tool-round-trip
  policy shared with the Rust model proxy.

Use [`@dbx-tools/model`](../model) for workspace catalogue I/O, fuzzy endpoint
selection, and cached discovery. This package is the generated native policy
surface consumed by `@dbx-tools/model` and `@dbx-tools/appkit-mastra`.
