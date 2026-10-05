# Mastra embeds mix identities and turn missing artifacts into a network error

Status: Open

## Summary

Mastra chat turns can complete their agent and Genie work but fail in the UI
while resolving the resulting chart and data embeds. Two behaviors must remain
separate:

1. A chart that cannot be resolved must be omitted or shown as unavailable
   without failing the answer.
2. Chart and statement artifacts created during one turn must be fetched using
   the same effective identity. The implementation must not mix the app service
   principal with the forwarded OBO user.

An inaccessible statement currently exposes a third defect: the statement
resolver returns `undefined` through a cached execution path. AppKit then tries
to serialize the value with `Buffer.from(undefined)`, replacing the intended
not-found response with a `500`.

## Observed deployment

- Application: `gismo-dev`
- `@dbx-tools/appkit-mastra`: `0.9.5`
- `@dbx-tools/ui-mastra`: `0.9.5`
- `@databricks/appkit`: `0.81.0`
- Genie identity mode: `auto`
- Request path: Databricks Apps front door with OBO enabled

The user asked:

> What plans are available near plan 33451? Show me plans with PlanID between
> 33440 and 33460 from v_plan_revision_log, including PlanID, Revision,
> MarketID, market_name, ModifiedDateTime. Order by PlanID desc.

The UI showed two Ask Genie calls, Code Analyze Tool, and then:

```text
Something went wrong
network error
```

At `2026-10-05T17:08:05Z`, app logs recorded two chart cache misses:

```text
WARN [mastra] embed:chart:not-found {
  status: 404,
  reason: 'unknown, expired, or owned by another identity'
}
```

The same turn then produced two data embed failures:

```text
WARN [mastra] embed:data:error {
  status: 500,
  error: 'Statement failed: The first argument must be of type string or an
  instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received
  undefined'
}
```

The same data failure occurred in this deployment on `2026-10-01T05:39:10Z`,
so it is not isolated to one prompt.

## Current code path

`appkit-mastra/src/plugin.ts` deliberately maps an inaccessible statement to
`undefined` so the embed route can return `404`. The callback runs through the
AppKit execution cache:

```ts
if (errorUtils.errorContext(err).notAccessible) return undefined;
```

The cache attempts to persist the callback result before the route handles it.
Its persistent serializer cannot encode `undefined`, causing the
`Buffer.from(undefined)` exception and an `ExecutionError` response.

Chart lookup separately derives an attributed user key from the request and
execution context. The observed cache misses indicate that the key used to
store the chart can differ from the key used by the browser fetch. Statement
Execution access shows the same likely producer-consumer identity mismatch.

## Expected behavior

- A missing, expired, or unauthorized chart does not fail the message or the
  chat turn.
- The answer text and any independently available data remain visible when a
  chart is unavailable.
- All artifacts created by one turn use one explicit effective identity for
  creation, cache ownership, Statement Execution, and browser hydration.
- OBO mode never falls back to the app service principal when an OBO identity
  is present.
- An inaccessible data embed produces a clean not-found or permission response,
  not a cache serialization error.
- Missing artifacts do not surface as the generic client-side `network error`.

## Required remediation

1. Keep chart absence local to the chart component. Treat `404` as unavailable
   content and do not reject the containing assistant message.
2. Define one turn-scoped artifact owner and pass it explicitly to chart
   creation, chart lookup, statement execution, and statement retrieval.
3. Do not infer artifact ownership independently at creation and retrieval.
4. Do not pass `undefined` through a cacheable execution callback. Return a
   typed result outside the cache, disable caching for not-found paths, or make
   the cache explicitly support non-values.
5. Preserve the security boundary. Do not retry an OBO-owned artifact as the
   service principal or disclose whether another identity owns an opaque ID.

## Acceptance tests

- Chart resolver `404` leaves assistant prose and data embeds usable.
- Two charts from one OBO turn resolve for that user after streaming completes.
- A chart created for user A remains inaccessible to user B without affecting
  user B's surrounding message.
- A statement created during an OBO Genie call can be hydrated by the same
  user's data embed request.
- An inaccessible statement returns the intended non-success response without
  invoking cache serialization on `undefined`.
- Service-principal-only turns continue to resolve their own artifacts.
- `auto` identity mode has explicit tests for both OBO-present and tokenless
  requests.
