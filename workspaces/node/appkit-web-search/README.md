# @dbx-tools/appkit-web-search

Server-side web-search runtime, Mastra tools, and AppKit plugin.

Import this package when an AppKit or Mastra backend needs to search the web and
read pages. `web_search` runs on the
[Databricks Model Serving native web-search tool](https://docs.databricks.com/aws/en/machine-learning/model-serving/web-search):
the model searches the web server-side and returns a synthesized answer plus the
sources it used - no third-party search API key. `web_fetch` reads a single page
through [`got-scraping`](https://www.npmjs.com/package/got-scraping) (browser-like
TLS + header fingerprints so a fetch survives common bot walls), which Databricks
has no equivalent for.

Key features:

- AppKit plugin registration that resolves and logs the effective policy at boot.
- Two Mastra tools: `web_search` (answer + citations) and `web_fetch` (page
  contents as readable text or raw HTML).
- `web_search` resolves its OWN web-search-capable model - defaulting to Gemini,
  then GPT - independently of the calling agent's chat model (which may not
  support web search). Loose names (`"gemini"`, `"gpt"`) fuzzy-match the live
  catalogue via [`@dbx-tools/model`](../model).
- A built-in provider -> tool-spec map (OpenAI Responses API
  `{"type":"web_search"}`, Gemini Chat Completions `{"google_search":{}}`),
  overridable per provider via the `WEB_SEARCH_TOOLS` setting.
- An optional URL allow-list (globs or bare hosts) built on
  [`@dbx-tools/path`](../path)'s `match` matcher: `web_search` silently filters
  disallowed citations, `web_fetch` refuses a disallowed URL.
- Per-tool approval gating: gate every call, or (for `web_fetch`) only calls
  whose URL matches a pattern, mapped onto Mastra's `requireApproval`.

## Why Use This Over Native AppKit

AppKit has no first-party web-search or page-fetch surface. Use this package when
an agent needs to look things up on the open web or read a URL the user pasted,
with a policy layer (allow-list + optional approval) around it so a deployment
controls which sites are reachable and which calls pause for a human. Crucially,
the web-search tool resolves its own web-search-capable model, so an agent
running on any chat model (including one without web search) can still search. It
is a thin add-on in the same shape as [`@dbx-tools/email`](../email): a Mastra
tool pair plus an AppKit plugin that primes their shared runtime.

## Register The AppKit Plugin

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { plugin as webSearchPlugin, tool as webTool } from "@dbx-tools/appkit-web-search";
import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";

const researcher = agents.createAgent({
  instructions: "Research questions using web_search, then read sources with web_fetch.",
  tools: () => ({
    web_search: webTool.webSearchTool(),
    web_fetch: webTool.webFetchTool(),
  }),
});

await createApp({
  plugins: [
    server(),
    lakebase(),
    webSearchPlugin.webSearch({
      model: "gemini", // defaults to Gemini, then GPT, when omitted
      allowedUrls: ["*.databricks.com", "docs.example.com"],
    }),
    mastraPlugin.mastra({ agents: researcher, storage: true }),
  ],
});
```

`plugin.webSearch()` resolves config (over env), compiles the allow-list, and
primes the shared runtime the tools reuse. `tool.webSearchTool()` /
`tool.webFetchTool()` build the two Mastra tools. Approval, when enabled,
requires Mastra storage, so register `lakebase()` or configure storage in the
Mastra plugin.

## Choose The Web-Search Model

The native web-search tool only runs on certain models, and it is provider-
specific. This package resolves a web-search-capable model INDEPENDENTLY of the
agent's chat model, so an agent on any model can still search:

- Default preference: an appropriate **Gemini**, then **GPT** (`modelFallbacks`).
- Pin one via `model` (or `WEB_SEARCH_MODEL`): an endpoint name
  (`"databricks-gemini-3-pro"`), a loose name (`"gemini"`, `"gpt"`), or a
  capability class - all fuzzy-matched against the live catalogue.
- Per call, the model can pass a `model` argument to override.
- If an explicitly requested model doesn't support web search (e.g. a Claude or
  Llama endpoint), the tool errors rather than silently searching with the wrong
  thing. When nothing is pinned, unsupported fallbacks are skipped.

The right provider tool-spec is selected automatically from the resolved model:
OpenAI GPT uses the Responses API `{"type":"web_search"}`; Gemini uses Chat
Completions `{"google_search":{}}`. Override or extend that map per provider with
the `webSearchTools` setting (env `WEB_SEARCH_TOOLS`, JSON) as the platform
evolves:

```ts
plugin.webSearch({
  model: "databricks-gemini-3-pro",
  webSearchTools: { gemini: { tool: { google_search: {} } } },
});
```

## Search And Fetch Without An Agent

```ts
import { search, fetch, runtime } from "@dbx-tools/appkit-web-search";
import { getExecutionContext } from "@databricks/appkit";

// Prime the shared runtime once (or let the plugin do it at setup):
runtime.getWebSearchRuntime({ model: "gemini", allowedUrls: ["*.databricks.com"] });

// web_search needs the OBO client + host from the active execution context:
const ctx = getExecutionContext();
const host = (await ctx.client.config.getHost()).toString();

const result = await search.runWebSearch(
  { query: "unity catalog lineage best practices" },
  runtime.getWebSearchRuntime().config,
  { client: ctx.client, host },
);
console.log(result.answer, result.citations, result.model);

const page = await fetch.runWebFetch(
  { url: result.citations[0]!.url, format: "text" },
  runtime.getWebSearchRuntime().config,
);
```

Use direct calls for operational lookups, tests, or admin flows where a model is
not involved. The same resolved runtime is used by the AppKit plugin and tools.

## Restrict Which URLs Are Reachable

```ts
import { allowlist } from "@dbx-tools/appkit-web-search";

const list = allowlist.toUrlAllowList(
  allowlist.parseAllowedUrls(["*.databricks.com", "docs.example.com/api/**"]),
);

list.allows("https://docs.databricks.com/aws/en/index.html"); // true
list.allows("https://evil.example.com/");                     // false
```

Each entry is a glob compiled by [`@dbx-tools/path`](../path)'s `match` matcher.
A host entry (no path, e.g. `databricks.com` or `*.databricks.com`) matches the
URL's hostname, and a bare host also matches its subdomains; a path entry
(`docs.example.com/api/**`) matches host + pathname. Enforcement is asymmetric by
design: `web_search` citations are silently filtered to the permitted set (the
model never surfaces a source it then can't fetch), while an explicit `web_fetch`
of a disallowed URL is refused with an error (a visible, correctable mistake). An
empty / absent allow-list permits everything.

## Gate Calls For Approval

Both tools run without approval by default. Pass `approval` to a tool (or set it
plugin-wide) to require a human click. `true` gates every call; a URL pattern (or
list) gates only calls whose URL matches - a `web_fetch` is evaluated precisely
against its target URL.

```ts
import { tool } from "@dbx-tools/appkit-web-search";

// Every fetch requires approval:
tool.webFetchTool({ approval: true });

// Only fetches of an internal domain require approval:
tool.webFetchTool({ approval: "*.internal.example.com" });

// Plugin-wide default (tools inherit unless they set their own):
plugin.webSearch({ approval: ["*.internal.example.com", "*.corp.example.com"] });
```

Approval uses the same glob syntax as the allow-list, so the two policies read
identically.

## Configuration

Resolution order is explicit config first, then env vars, then a built-in
default:

- `WEB_SEARCH_MODEL` (default web-search model; else the Gemini->GPT fallbacks);
- `WEB_SEARCH_MODEL_FALLBACKS` (comma/space-separated candidate ids);
- `WEB_SEARCH_TOOLS` (JSON provider -> tool-spec override map);
- `WEB_SEARCH_FUZZY` / `WEB_SEARCH_FUZZY_THRESHOLD` (loose-name matching; default on / 0.4);
- `WEB_SEARCH_MAX_CITATIONS` (default 10);
- `WEB_SEARCH_FETCH_MAX_LENGTH` (default 50000 characters);
- `WEB_SEARCH_TIMEOUT_MS` (default 30000);
- `WEB_SEARCH_ALLOWED_URLS` (comma/space-separated globs; empty = unrestricted).

The plugin's `maxCitations` / `fetchMaxLength` are hard caps: a per-call request
may narrow them but never exceed them.

Requirements: the native web-search tool runs on pay-per-token GPT / Gemini
serving endpoints with cross-region processing enabled; it is unavailable on
provisioned throughput, for external models, or under HIPAA/BAA compliance. See
the [Databricks docs](https://docs.databricks.com/aws/en/machine-learning/model-serving/web-search).

## Modules

- `plugin` - `WebSearchPlugin`, `webSearch()` AppKit plugin factory.
- `tool` - `webSearchTool()` / `webFetchTool()` Mastra tools.
- `search` - `runWebSearch()` over the Databricks native web-search tool.
- `provider` - provider detection + the provider -> tool-spec map.
- `fetch` - `runWebFetch()` over got-scraping, plus `htmlToText()`.
- `runtime` - shared runtime, `getWebSearchRuntime()`, `resetWebSearchRuntime()`.
- `config` - config types, JSON schema, `resolveWebSearchConfig()`, approval helpers.
- `allowlist` - URL allow-list parsing/compiling on top of `@dbx-tools/path`.
- `schema` - zod tool contracts and inferred types.

Pair this package with [`@dbx-tools/appkit-mastra`](../appkit-mastra) to spread
the tools into an agent (and resolve its own model via [`@dbx-tools/model`](../model)),
and [`@dbx-tools/email`](../email) for the sibling approval-gated tool pattern.
