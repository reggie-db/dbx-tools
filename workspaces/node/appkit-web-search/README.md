# @dbx-tools/appkit-web-search

Server-side web-search runtime, Mastra tools, and AppKit plugin.

Import this package when an AppKit or Mastra backend needs to search the web and
read pages - no API key required. Search runs through
[`duck-duck-scrape`](https://www.npmjs.com/package/duck-duck-scrape) (the Node
counterpart to the Python [`ddgs`](https://github.com/deedy5/ddgs) metasearch
library, which scrapes DuckDuckGo's public endpoints), and page fetching runs
through [`got-scraping`](https://www.npmjs.com/package/got-scraping) (browser-like
TLS + header fingerprints so a fetch survives common bot walls).

Key features:

- AppKit plugin registration that resolves and logs the effective policy at boot.
- Two Mastra tools: `web_search` (ranked results) and `web_fetch` (page contents
  as readable text or raw HTML).
- An optional URL allow-list (globs or bare hosts) built on
  [`@dbx-tools/path`](../path)'s `match` matcher: `web_search` silently filters
  disallowed results, `web_fetch` refuses a disallowed URL.
- Per-tool approval gating: gate every call, or only calls whose URL matches a
  pattern, mapped onto Mastra's `requireApproval`.
- No credentials to configure - the backend needs no API key.

## Why Use This Over Native AppKit

AppKit has no first-party web-search or page-fetch surface. Use this package when
an agent needs to look things up on the open web or read a URL the user pasted,
with a policy layer (allow-list + optional approval) around it so a deployment
controls which sites are reachable and which calls pause for a human. It is a
thin add-on in the same shape as [`@dbx-tools/email`](../email): a Mastra tool
pair plus an AppKit plugin that primes their shared runtime.

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
    webSearchPlugin.webSearch({ allowedUrls: ["*.databricks.com", "docs.example.com"] }),
    mastraPlugin.mastra({ agents: researcher, storage: true }),
  ],
});
```

`plugin.webSearch()` resolves config (over env), compiles the allow-list, and
primes the shared runtime the tools reuse. `tool.webSearchTool()` /
`tool.webFetchTool()` build the two Mastra tools. Approval, when enabled,
requires Mastra storage, so register `lakebase()` or configure storage in the
Mastra plugin.

## Search And Fetch Without An Agent

```ts
import { search, fetch, runtime } from "@dbx-tools/appkit-web-search";

// Prime the shared runtime once (or let the plugin do it at setup):
runtime.getWebSearchRuntime({ allowedUrls: ["*.databricks.com"] });

const hits = await search.runWebSearch(
  { query: "unity catalog lineage", maxResults: 5 },
  runtime.getWebSearchRuntime().config,
);

const page = await fetch.runWebFetch(
  { url: hits.results[0]!.url, format: "text" },
  runtime.getWebSearchRuntime().config,
);
```

Use direct calls for operational lookups, tests, or admin flows where a model is
not involved. The same resolved runtime is used by the AppKit plugin and tools.

## Restrict Which URLs Are Reachable

```ts
import { allowlist } from "@dbx-tools/appkit-web-search";

const list = allowlist.toUrlAllowList(
  allowlist.parseAllowedUrls(["*.databricks.com", "docs.example.com"]),
);

list.allows("https://docs.databricks.com/aws/en/index.html"); // true
list.allows("https://evil.example.com/");                     // false
```

Each entry is a glob compiled by [`@dbx-tools/path`](../path)'s `match` matcher
and tested against a URL's full `href`. A bare host (no glob metacharacter, no
scheme, e.g. `databricks.com`) is widened to `**databricks.com**` so you can list
domains without writing globs; anything already containing `*` / `/` / `:` is used
verbatim. Enforcement is asymmetric by design: `web_search` results are silently
filtered to the permitted set (the model never sees a URL it then can't fetch),
while an explicit `web_fetch` of a disallowed URL is refused with an error (a
visible, correctable mistake). An empty / absent allow-list permits everything.

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

- `WEB_SEARCH_SAFE_SEARCH` (`strict` | `moderate` | `off`; default `moderate`);
- `WEB_SEARCH_REGION` (e.g. `us-en`; default `wt-wt`, any region);
- `WEB_SEARCH_MAX_RESULTS` (default 10);
- `WEB_SEARCH_FETCH_MAX_LENGTH` (default 50000 characters);
- `WEB_SEARCH_TIMEOUT_MS` (default 15000);
- `WEB_SEARCH_ALLOWED_URLS` (comma/space-separated globs; empty = unrestricted).

The plugin's `maxResults` / `fetchMaxLength` are hard caps: a per-call request may
narrow them but never exceed them.

## Modules

- `plugin` - `WebSearchPlugin`, `webSearch()` AppKit plugin factory.
- `tool` - `webSearchTool()` / `webFetchTool()` Mastra tools.
- `search` - `runWebSearch()` over duck-duck-scrape.
- `fetch` - `runWebFetch()` over got-scraping, plus `htmlToText()`.
- `runtime` - shared runtime, `getWebSearchRuntime()`, `resetWebSearchRuntime()`.
- `config` - config types, JSON schema, `resolveWebSearchConfig()`, approval helpers.
- `allowlist` - URL allow-list parsing/compiling on top of `@dbx-tools/path`.
- `schema` - zod tool contracts and inferred types.

Pair this package with [`@dbx-tools/appkit-mastra`](../appkit-mastra) to spread
the tools into an agent, and [`@dbx-tools/email`](../email) for the sibling
approval-gated tool pattern.
