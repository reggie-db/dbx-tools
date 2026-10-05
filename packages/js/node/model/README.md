# @dbx-tools/model

Workspace-aware Databricks Model Serving selection.

Import this package when server-side code needs to turn a loose model request
like `"claude sonnet"` or `"chat-fast"` into a concrete serving endpoint in the
current workspace. It lists `/serving-endpoints`, caches and enriches the
catalogue, classifies endpoints by capability, fuzzy-matches names, and falls
back to a small static floor when the live catalogue is unavailable.

Browser-safe request/result schemas and endpoint classification types live in
[`@dbx-tools/shared-model`](../../shared/model).

Key features:

- Lists Databricks Model Serving endpoints through the SDK and normalizes them
  into a stable summary shape with TypeScript-owned family and reasoning-effort
  metadata.
- Classifies endpoints into chat-thinking, chat-balanced, chat-fast, and
  embedding classes using Foundation Model API scores and family heuristics.
- Resolves loose user input such as `"sonnet"` or `"chat fast"` to a concrete
  endpoint id.
- Supports class ceilings so callers can ask for a capability band without
  accidentally escalating to a larger model.
- Supports `requiresTools` filtering so callers select only
  endpoints verified for a complete function-call and result-replay round-trip.
- Caches enriched catalogues per workspace host through AppKit cache utilities,
  and re-lists once on a resolve miss so a newly deployed model still resolves.
- Builds the invocations URL and mints per-request auth headers for callers that
  issue their own OpenAI-shaped HTTP requests.
- Provides build-generated retirement, Responses, image-input, apply-patch,
  web-search, ITPM, OTPM, and QPH metadata through cached in-process lookups.
- Provides a small static fallback floor for local tools and degraded workspace
  access.

## Why Not Just AppKit Serving?

Native AppKit's Model Serving plugin is the right choice when you already know
the endpoint alias you want. It gives you authenticated invoke/stream routes,
OBO execution, generated endpoint types, request-body filtering, and frontend
hooks.

Use this package before or beside that layer when the hard part is choosing the
endpoint:

- resolve loose human input such as `"sonnet"` or `"fast"` against the live
  workspace catalogue;
- group endpoints into capability classes like `chat-thinking`, `chat-balanced`,
  `chat-fast`, and `embedding`;
- enforce class ceilings so a caller can degrade to smaller models without
  escalating to a larger one;
- build model pickers and debug routes from a cached, enriched endpoint list;
- keep local agents and CLIs working with a static fallback when catalogue
  access is unavailable.

## Use The Portable Model Client

```ts
import { createModelClient } from "@dbx-tools/model";

const models = await createModelClient({
  auth: { profile: "DEFAULT" },
  cacheTtlMs: 60_000,
});

const selected = await models.resolveModel({ explicit: "gpt" });
const route = await models.route({
  explicit: selected.modelId,
  protocol: "responses",
});

const response = await fetch(route.url, {
  method: "POST",
  headers: { ...route.headers, "content-type": "application/json" },
  body: JSON.stringify({ model: route.modelId, input: "Hello" }),
});
```

`createModelClient()` is the portable auth-backed facade embedded by the Python
model proxy. It lists and normalizes endpoints, caches one
catalogue per host, workspace ID, and principal, refreshes once after an
unmatched fuzzy request, resolves routes, returns complete authentication
headers, exposes profiles, and returns the package's generated metadata. Its
portable `@dbx-tools/model/python` entrypoint excludes the AppKit catalogue
wrapper while reusing the same pure ranking and policy implementation.

## Select One Model

```ts
import { createWorkspaceClient } from "@databricks/appkit";
import { resolve } from "@dbx-tools/model";

const client = createWorkspaceClient();
const host = String(await client.config.getHost());

const selected = await resolve.selectModel(client, host, {
  explicit: "claude sonnet",
});

console.log(selected.modelId, selected.source);
```

`selectModel()` is the high-level helper for agents and CLIs. It reads the live
catalogue, applies fuzzy matching when an explicit string is present, then
returns a single `modelId` plus a source label explaining why that endpoint won.
Set `liveOnly: true` for an unpinned production default that must select the
highest-ranked currently available endpoint and must not fall through to an
offline static id when the catalogue has no match.
With no explicit id or class, automatic selection prefers the highest-ranked
live GPT family member, then falls back to the highest-ranked live chat model.

The `source` label is useful for logs and debug UIs. It distinguishes explicit
matches from class-based selection, environment defaults, and fallback results,
so operators can tell whether a request used the intended model policy.

## Build A Model Picker

```ts
import { resolve } from "@dbx-tools/model";

const ranked = await resolve.searchModels(client, host, {
  search: "opus",
  modelClass: "chat-thinking",
  requiresTools: true,
  limit: 5,
});
```

Use `searchModels()` for UI pickers and debug routes. It returns ranked models
with match scores and endpoint summaries, using the same fuzzy threshold and
class ceiling logic as `selectModel()`. Classification, fuzzy scoring,
family-version order, and variant preference are implemented directly in this
package and require no native binding.

## Work With A Held Catalogue

When you already have endpoint summaries, use the pure resolver functions from
`resolve` and `modelCatalog` without another workspace call:

```ts
import { modelCatalog, resolve } from "@dbx-tools/model";

const endpoints = await modelCatalog.listServingEndpoints(client, host);
const ranked = resolve.lookupModels(endpoints, { search: "sonnet", limit: 3 });
const picked = resolve.resolveModel(endpoints, {
  explicit: "claude sonnet",
  modelClass: "chat-balanced",
  requiresTools: true,
});
```

The class acts as a ceiling. `chat-balanced` may fall back to `chat-fast`, but
will not escalate to `chat-thinking`. Embedding endpoints are considered only
when the requested class is `embedding`.

## List And Cache Serving Endpoints

```ts
import { modelCatalog } from "@dbx-tools/model";

const endpoints = await modelCatalog.listServingEndpoints(client, host, {
  ttlMs: 5 * 60_000,
});

const raw = await modelCatalog.listServingEndpointsUncached(client);
await modelCatalog.clearServingEndpointsCache(host);
```

`listServingEndpoints()` uses AppKit's `CacheManager`, enriches endpoints with
classification and embedding dimensions, and keys the cache by workspace host.
`listServingEndpointsUncached()` is useful for simple scripts that only need the
SDK response and do not want a cache dependency.

## Fuzzy Resolve Endpoint Names

```ts
const matches = serving.searchServingEndpoints("claude sonnet", endpoints, {
  threshold: 0.35,
});

const endpointName = serving.resolveModelId("sonnet", endpoints);
```

Fuzzy matching is intentionally a server concern because it depends on the live
workspace catalogue and may re-list on misses. Disable it in callers that require
exact endpoint ids.

## Resolve Against A Catalogue That May Be Stale

```ts
const resolved = await resolve.rankModelIdLive((force) => loadCatalogue(force), "opus");
```

`rankModelIdLive()` matches the catalogue you already hold and, on a miss,
reloads once with `force` before giving up, so a model deployed after your cache
warmed still resolves without a restart. You supply the loader, so the caching
policy stays yours: `listServingEndpoints` and its `CacheManager`, a plain field
in a long-lived CLI, or a test double. `rankModelId()` is the pure form over a
single snapshot; unlike `serving.resolveModelId` it breaks equal match scores by
class and then version, so `"opus"` prefers `opus-5` over `opus-4-7`.

## Call An Endpoint Directly

```ts
import { invoke } from "@dbx-tools/model";

const response = await fetch(invoke.invocationsUrl(host, endpointId), {
  method: "POST",
  headers: { ...(await invoke.authHeaders(client)), "content-type": "application/json" },
  body: JSON.stringify({ messages }),
});
```

Use `invoke` when you need to issue your own request against a serving endpoint
with an OpenAI-shaped body - a proxy, a passthrough route, a streaming client -
rather than the SDK's typed `servingEndpoints.query`. Mint `authHeaders()` per
request: the SDK refreshes the underlying token as it nears expiry, so you never
track lifetimes yourself.

Every serving path this repo talks to is a constant here, with a matching URL
builder: `INVOCATIONS_SUFFIX` / `invocationsUrl()`, `RESPONSES_PATH` /
`responsesUrl()`, `OPEN_RESPONSES_PATH` / `openResponsesUrl()`, and
`CHAT_COMPLETIONS_PATH` / `chatCompletionsUrl()`. Import one instead of writing a
`/serving-endpoints/...` literal in a consumer: which path a model can accept is
a property of the model (see `isResponsesOnly()` and `responsesUpstreamUrl()`),
so a hard-coded string in one package silently diverges when that routing
changes. `isResponsesOnly()` covers Codex and GPT 5.4+ endpoints, which reject
tool-bearing Chat Completions, while keeping GPT-OSS on its supported Chat path.
The TypeScript helper owns this policy, so Node consumers and generated Python
bindings share one version threshold without loading a native library.

## Read Published Model Metadata

```ts
import { metadata } from "@dbx-tools/model";

const capabilities = metadata.modelCapabilitiesFor("databricks-gpt-5-4");
const limits = metadata.modelRateLimitsFor("gpt-5.4");
const status = metadata.modelStatusFor("system.ai.gemini-2-5-pro");
```

The package ships committed snapshots generated from Databricks documentation
by `bun run model:metadata`. Runtime calls normalize endpoint, display,
foundation-model, and provider identities into memoized sets and maps; they do
not fetch documentation. `modelMetadataFor()` returns status, capabilities, and
published limits together for a string or `ServingEndpointSummary`.

## Use Static Fallbacks

```ts
import { classes, fallback } from "@dbx-tools/model";
import { model } from "@dbx-tools/shared-model";

const cls = classes.parseModelClass("chat-fast") ?? model.ModelClass.ChatFast;
const modelId = fallback.modelForClass(cls);
```

The fallback floor gives agents and local scripts a stable answer when a
workspace cannot list endpoints. Prefer live catalogue resolution for production
policy decisions; fallbacks are a last resort.

## Modules

- `resolve` - high-level `selectModel`, TypeScript-ranked search, and
  catalogue-held resolver functions.
- `serving` - Databricks serving-endpoint listing, cache management, fuzzy
  search, and endpoint-id resolution.
- `invoke` - serving-path constants, URL construction, and per-request auth
  headers for calling an endpoint over raw HTTP.
- `metadata` - build-generated retirement, capability, and rate-limit snapshots
  with cached normalized lookups.
- `modelClient` - portable authentication-aware discovery, selection, routing,
  profile, and metadata facade.
- `classes` - model-class parsing, ordering, and class-ceiling helpers.
- `policy` - family, serving-protocol, tool, and reasoning-effort policy.
- `fallback` - static fallback model ids per class.

The AppKit-Mastra integration uses this package through
[`@dbx-tools/appkit-mastra`](../appkit-mastra).
