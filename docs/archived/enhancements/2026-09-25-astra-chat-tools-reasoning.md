# Astra Chat Completions tools need `reasoning_effort: none`

Created: September 25, 2026.

Status: Completed and archived September 25, 2026.

## Goal

Make Databricks-hosted `databricks-gpt-6-astra` usable as a Mastra agent model with function tools, without each app wrapping `fetch`.

## Verified diagnosis

PassengerIQ `createAgent` used `model: "databricks-gpt-6-astra"` plus Genie tools. A one-word user message (`tgest`) failed in MastraChat as `Something went wrong` / `Bad Request`.

The serving call was Chat Completions (`/serving-endpoints/chat/completions`) with a non-empty `tools` array. Astra rejects that combination unless the body also sets `reasoning_effort` to `"none"`. Claude Opus 4.8 on the same agent and tools succeeds.

`supportsToolsByFamily("databricks-gpt-6-astra")` is true because the name is family `gpt`. The resolver therefore allows tools. The 400 is a wire-option requirement, not a catalogue miss.

The existing Mastra serving interceptor does not cover this:

- `packages/js/node/appkit-mastra/src/model.ts` `setupFetchInterceptor` returns early unless `typeof init?.body === "string"`. Mastra / the AI SDK often pass a `Request` with the JSON on `input`, so the rewrite never runs.
- `rewriteServingBody` in `packages/js/node/appkit-mastra/src/serving-sanitize.ts` only strips unsupported Chat fields and repairs Claude transcript replay. It does not set `reasoning_effort` for Astra.

PassengerIQ currently papers over both issues in `server/server.ts` (`_installAstraToolCompatibility`) and pins the default agent to `databricks-claude-opus-4-8`. That app workaround should go away once this lands.

## Scope and ownership

- `packages/js/node/appkit-mastra/src/model.ts`: read and rewrite `Request` bodies, not only `init.body`.
- `packages/js/node/appkit-mastra/src/serving-sanitize.ts`: when `model` is Astra (or a later name with the same Chat Completions constraint) and `tools` is a non-empty array, set `reasoning_effort` to `"none"` if the caller did not already set a value.
- Tests next to `serving-sanitize.test.ts` and the fetch interceptor.
- Optional: document the constraint in `@dbx-tools/appkit-mastra` README near other serving rewrites.

Do not change `supportsToolsByFamily` to exclude Astra. Vision and forced-tool experiments still want tools; they need the extra field.

Do not change PassengerIQ's default agent in this work. That app can drop the local interceptor after a published dbx-tools release.

## Implementation plan

### 1. Fetch interceptor

- [x] Clone and read `input` when it is a `Request` and `init.body` is absent.
- [x] After rewrite, rebuild the `Request` (drop `content-length`) or pass `{ ...init, body }`.
- [x] Keep the existing Claude / Gemini sanitize path on the rewritten string.

### 2. Astra tools field

- [x] Detect Astra by endpoint / model id (token `astra` on a `gpt` family name is enough).
- [x] Only when `tools.length > 0`.
- [x] Write `reasoning_effort: "none"` unless the body already has `reasoning_effort`.
- [x] Cover Chat Completions. The shared serving-path interceptor applies the same body sanitizer to `/invocations`.

### 3. Tests

- [x] `rewriteServingBody` with Astra + tools adds `reasoning_effort: "none"`.
- [x] Claude + tools is unchanged.
- [x] Astra without tools is unchanged.
- [x] Existing `reasoning_effort` on the body is preserved.
- [x] Interceptor test: `fetch(new Request(url, { method: "POST", body }))` with no `init` still rewrites.

## Completion evidence

- Fourteen focused serving sanitizer tests pass, including Request-owned bodies.
- The full `@dbx-tools/appkit-mastra` suite passes with 105 tests.
- Package and demo server TypeScript compilation pass.
- Canonical and package documentation describe the Astra constraint.

## Non-goals

- Switching the default Mastra model off Astra. Callers keep choosing the endpoint.
- Teaching Astra vision (`DATABRICKS_SERVING_ENDPOINT_LLM`) about Chat Completions. That path is invocations / image, not this agent loop.
- A general "disable reasoning on every GPT-6 model" rule. Confirm the 400 on Astra first; other GPT-6 ids may differ.

## Evidence

- PassengerIQ local generate: Astra + tools -> HTTP 400; Claude Opus 4.8 + tools -> 200 and a normal reply to `tgest`.
- Databricks Chat Completions: Astra + tools without `reasoning_effort` is the failing shape; adding `"none"` is the required option.
