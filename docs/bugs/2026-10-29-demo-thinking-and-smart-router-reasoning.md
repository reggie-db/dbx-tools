# Demo omits reasoning events and Smart Router can replay incompatible encrypted reasoning

Status: Open

## Summary

The demo has two related Responses API defects:

1. The chat stream enables reasoning output downstream but does not request a
   visible reasoning summary from the upstream model. The model can spend
   reasoning tokens without producing `reasoning-*` stream events for the UI.
2. Smart Router can select a different concrete model on a later chat turn and
   replay encrypted reasoning metadata produced by the previous model. The new
   model can reject that metadata with `invalid encrypted reasoning`.

The first cause is confirmed by the request construction, stream adapters, UI
code, and a local stream probe. The second cause is the strongest explanation
supported by the routing and provider replay paths. The exact failing request
or trace was not available to confirm which two concrete models were involved.

AppKit-Mastra must own provider-aware reasoning defaults for every supported
reasoning-capable model. The demo and other consumers must receive normalized
reasoning events without adding their own provider options. Responses models
use `reasoningSummary: "auto"`. Other supported protocols use their native
reasoning output.

## Observed behavior

The demo's reasoning-effort control changes the requested effort, but the UI
does not receive visible model reasoning events. A read-only request to
`POST /api/mastra/chat/support` with Smart Router, high reasoning effort, and a
forced `get_weather` tool call emitted tool, text, step, and completion events.
It emitted no `reasoning-start`, `reasoning-delta`, or `reasoning-end` events.

A separate Smart Router turn returned:

```json
{
  "error_code": "BAD_REQUEST",
  "message": "{\"error\":{\"code\":\"validation_error\",\"message\":\"invalid encrypted reasoning\",\"param\":null,\"type\":\"invalid_request_error\"}}"
}
```

## Cause of missing reasoning events

`packages/js/node/appkit-mastra/src/chat.ts` defaults `sendReasoning` to true
and passes it to both Mastra stream conversion paths. This option only permits
existing reasoning chunks to reach the AI SDK UI stream. It does not request
reasoning text from the model.

`packages/js/ui/mastra/src/support/mastra-client.ts` sends only
`reasoningEffort` in the OpenAI provider options. The AppKit-Mastra defaults in
`packages/js/node/appkit-mastra/src/model.ts` add `store: false`, but they do
not set `reasoningSummary`.

The installed `@ai-sdk/open-responses` provider sends a Responses API
`reasoning.summary` request only when `reasoningSummary` is `auto`, `concise`,
or `detailed`. Its stream parser creates visible reasoning deltas from
`response.reasoning_summary_text.delta`. Reasoning effort controls the model's
reasoning work, but it does not request that visible summary.

The downstream path is otherwise complete:

- `@mastra/ai-sdk` forwards `reasoning-start`, `reasoning-delta`, and
  `reasoning-end` when `sendReasoning` is true.
- `packages/js/ui/mastra/src/react/_assistant-activity.ts` converts AI SDK
  `reasoning` parts into thought activity items.
- `packages/js/ui/mastra/src/react/bubbles.tsx` renders those items with
  `ThoughtsDisclosure`.

The missing events therefore originate at request construction. No visible
summary is requested, so the provider usually has no reasoning text to emit.
Model and endpoint support still determine whether a requested summary is
returned.

## Cause of invalid encrypted reasoning

Responses turns set `store: false`, so the client must replay the complete
conversation during tool continuations and later turns. The Open Responses
provider retains returned reasoning metadata, including the reasoning item ID
and `reasoningEncryptedContent`. When it converts stored assistant history into
a later request, it serializes that metadata as a `reasoning` input with
`encrypted_content`.

Encrypted reasoning is provider and model state. It is valid for continuation
with the concrete model that produced it, but it is not portable conversation
text.

`packages/js/node/appkit-mastra/src/model.ts` memoizes Smart Router resolution
in `MASTRA_SMART_ROUTER_RESOLUTION_KEY`. This pins all agent steps that share
one Mastra `RequestContext` to one concrete model. The local forced-tool probe
completed successfully, which confirms that the within-turn pinning
works for that case.

Each new HTTP chat turn receives a new request context. Smart Router can
therefore select model B on a later turn while the persisted conversation still
contains encrypted reasoning from model A. The provider then replays model A's
encrypted blob to model B, and model B can reject the request as `invalid
encrypted reasoning`.

The generic model-gateway Smart Router has logical-turn continuation pinning,
but the Mastra integration resolves through `SmartRouterService` and retains
the selection only for one request context. It does not provide thread-level
model affinity or remove model-bound provider state when a later turn changes
models.

Commit `524966c09` coalesced Smart Router selection within one request. That
change reduces the older risk of selecting different models across steps of
one tool turn. It does not prevent a model change between separate user turns.

## Confidence and limitations

The missing-reasoning cause is confirmed by local source inspection, the
installed provider implementation, and a local SSE probe.

The encrypted-reasoning cause is strongly supported by these facts:

- Smart Router selection can change between request contexts.
- The provider persists and replays encrypted reasoning from assistant history.
- The serving endpoint explicitly rejected that replay state as invalid.
- A same-request tool turn stayed on one model and did not reproduce the error.

The failing trace was not supplied, so the investigation did not verify the
previous and selected concrete model IDs for that request. Treat the
cross-turn A-to-B sequence as inferred until a trace or request capture
confirms those IDs.

## Required remediation

1. Make visible reasoning the AppKit-Mastra default for every supported
   reasoning-capable model and protocol. AppKit-Mastra must apply the required
   provider-native request options and normalize the result into AI SDK
   reasoning events. The demo and consuming applications must not need
   model-specific reasoning configuration.
2. Set `reasoningSummary: "auto"` in AppKit-Mastra's default Responses provider
   options whenever reasoning emission is enabled. Preserve native reasoning
   output for supported non-Responses protocols.
3. Keep `sendReasoning` as the AppKit-Mastra visibility control. Its default
   remains enabled. `sendReasoning: false` must disable provider reasoning
   output requests where applicable and suppress downstream reasoning events.
4. Before replaying history to a newly selected concrete model, remove
   model-bound Responses metadata such as `itemId`,
   `reasoningEncryptedContent`, and incompatible reasoning items. Preserve
   user-visible text and tool history.
5. Track the concrete model that owns each reasoning artifact and replay its
   encrypted content only when the next model matches.
6. If model-bound metadata cannot be sanitized safely, pin one concrete model
   for the thread. This option prevents the mismatch but reduces Smart Router's
   ability to select a model independently for each turn.
7. Continue to use stateless replay for Databricks Responses. Do not replace it
   with `item_reference`, which the Databricks endpoint rejects.

## Acceptance tests

- A capability-based test matrix covers every model family and protocol that
  AppKit-Mastra advertises as reasoning-capable.
- AppKit-Mastra's default configuration emits normalized AI SDK reasoning
  events for each model in that matrix without demo-specific or
  consumer-specific options.
- Responses requests send `reasoning.summary: "auto"` by default.
- Supported non-Responses providers retain their native reasoning request and
  stream behavior before AppKit-Mastra normalizes the events.
- `sendReasoning: false` omits provider reasoning-output options where
  applicable and emits no reasoning parts for any model in the matrix.
- An explicit supported provider setting can override the AppKit-Mastra
  default.
- A supported Responses model's summary deltas become AI SDK reasoning parts
  and render in the demo.
- A model that does not return a summary still completes without an empty or
  failed thought disclosure.
- A same-model multi-step tool continuation retains and replays encrypted
  reasoning.
- Smart Router switching from model A to model B between user turns removes
  model A's encrypted reasoning before calling model B.
- Smart Router selecting model A again retains model A's compatible encrypted
  reasoning.
- A model switch preserves user-visible assistant text, user messages, tool
  calls, and tool results.
- Stateless Databricks Responses requests contain no `item_reference` inputs.

