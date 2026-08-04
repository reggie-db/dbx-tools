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

**Key features:**

- AppKit plugin registration that resolves and logs the effective policy at boot.
- Two Mastra tools: `web_search` (answer + citations) and `web_fetch` (page
  contents as readable text or raw HTML), plus the same pair as AppKit agent
  tools through the plugin's `ToolProvider`.
- `web_search` resolves its OWN web-search-capable model - defaulting to Gemini,
  then GPT - independently of the calling agent's chat model (which may not
  support web search). Loose names (`"gemini"`, `"gpt"`) fuzzy-match the live
  catalogue via [`@dbx-tools/model`](../model).
- A built-in provider -> tool-spec map (OpenAI Responses API
  `{"type":"web_search"}`, Gemini Chat Completions `{"google_search":{}}`),
  overridable per provider via the `WEB_SEARCH_TOOLS` setting.
- A named URL policy (`allowlist` or `unrestricted`) over a glob allow-list
  built on [`@dbx-tools/path`](../path)'s `match` matcher: `web_search` silently
  filters disallowed citations, `web_fetch` refuses a disallowed URL, and the
  mode in force is logged at boot.
- Per-tool approval gating: gate every call, or (for `web_fetch`) only calls
  whose URL matches a pattern, mapped onto Mastra's `requireApproval`.
- Every outbound call runs through AppKit's `execute()` chain - per-user cache,
  retry with jittered backoff, timeout, telemetry - and unwinds on an
  `AbortSignal`.

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

`plugin.webSearch()` resolves config (over env), compiles the URL policy, and
primes the shared runtime the tools reuse. `tool.webSearchTool()` /
`tool.webFetchTool()` build the two Mastra tools. Approval, when enabled,
requires Mastra storage, so register `lakebase()` or configure storage in the
Mastra plugin.

The plugin is also an AppKit `ToolProvider`, so an AppKit agent can take the
same two tools without Mastra in the picture:

```ts
import { createAgent } from "@databricks/appkit/beta";

const researcher = createAgent({
  instructions: "Research questions with web_search, then read sources with web_fetch.",
  tools: (plugins) => ({ ...plugins["web-search"].toolkit() }),
});
```

Both tools are annotated `effect: "read"` and require user context, and neither
is auto-inheritable: an agent has to ask for them, because `web_fetch` reaches
whatever URL the model produces.

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

The endpoint id is read in this order, and where it came from changes what
happens when it cannot run web search:

| Order | Source                             | Unsupported endpoint       |
| ----- | ---------------------------------- | -------------------------- |
| 1     | `model` in plugin config           | Error                      |
| 2     | `WEB_SEARCH_MODEL`                 | Error                      |
| 3     | `DATABRICKS_SERVING_ENDPOINT_NAME` | Skipped, fallbacks apply   |
| 4     | `modelFallbacks`                   | Skipped, next one is tried |

`DATABRICKS_SERVING_ENDPOINT_NAME` is AppKit's standard name for a Model
Serving binding, and it is the field the plugin declares in its manifest, so
`app.yaml` / bundle wiring reaches this plugin the way it reaches any other.
Because that binding is usually the app's chat endpoint - which need not
support web search - it is treated as a preference rather than a pin.
`WEB_SEARCH_MODEL` stays as the dedicated override for pointing web search at
a different endpoint than the rest of the app.

Model resolution runs against the LIVE workspace catalogue (via
[`@dbx-tools/model`](../model)), so it only ever picks an endpoint that is
actually deployed - a configured id that doesn't exist is never called.

### Scrape Fallback

The native tool is always preferred. But when the workspace has NO deployed
GPT/Gemini endpoint (so native web search can't run at all), the tool falls
back to a DuckDuckGo scrape (via `got-scraping`) so it still returns results
instead of erroring. Fallback results set `model` to `"scrape:duckduckgo"` and
carry the substance in `citations` (there is no model synthesizing an answer,
so `answer` is a lead-in over the top results). It is enabled by default; set
`scrapeFallback: false` (or `WEB_SEARCH_SCRAPE_FALLBACK=0`) to require a native
model and error when none is deployed.

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
// result.answer, result.citations, result.model

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
list.allows("https://evil.example.com/"); // false
```

Each entry is a glob compiled by [`@dbx-tools/path`](../path)'s `match` matcher.
A host entry (no path, e.g. `databricks.com` or `*.databricks.com`) matches the
URL's hostname, and a bare host also matches its subdomains; a path entry
(`docs.example.com/api/**`) matches host + pathname. Enforcement is asymmetric by
design: `web_search` citations are silently filtered to the permitted set (the
model never surfaces a source it then can't fetch), while an explicit `web_fetch`
of a disallowed URL is refused with an error (a visible, correctable mistake).
`web_fetch` accepts only HTTPS targets that resolve to public addresses, and
reapplies both checks before every redirect request.

Which of the two modes is in force is named by `urlPolicy`, and the effective
mode is in the boot log:

| `urlPolicy`      | Effect                                   |
| ---------------- | ---------------------------------------- |
| `"allowlist"`    | Only `allowedUrls` entries are reachable |
| `"unrestricted"` | Any public HTTPS URL is reachable        |

Leave `urlPolicy` unset and it follows `allowedUrls`: `"allowlist"` when there
are entries, `"unrestricted"` when there are none. Set it to say which one you
meant. The two contradictions fail at startup rather than quietly picking a
side: `"allowlist"` with no entries, and `"unrestricted"` with entries.

```ts
// An open deployment, said out loud:
plugin.webSearch({ urlPolicy: "unrestricted" });

// A closed one:
plugin.webSearch({ urlPolicy: "allowlist", allowedUrls: ["*.databricks.com"] });
```

## Gate Calls For Approval

Both tools run without approval by default. Pass `approval` to a tool (or set it
plugin-wide) to require a human click. `true` gates every call; a URL pattern (or
list) gates only calls whose URL matches - a `web_fetch` is evaluated precisely
against its target URL, while a `web_search` (whose result URLs are unknown
before the call) treats a pattern gate as "gate every call".

```ts
import { tool } from "@dbx-tools/appkit-web-search";

// Every fetch requires approval:
tool.webFetchTool({ approval: true });

// Only fetches of an internal domain require approval:
tool.webFetchTool({ approval: "*.internal.example.com" });

// The same thing, with the mode named:
tool.webFetchTool({ approval: { mode: "urls", patterns: ["*.internal.example.com"] } });

// Plugin-wide default (tools inherit unless they set their own):
plugin.webSearch({ approval: ["*.internal.example.com", "*.corp.example.com"] });
```

Every spelling normalizes to one of three modes - `{ mode: "none" }`,
`{ mode: "always" }`, `{ mode: "urls", patterns }` - which is what the resolved
config carries and the boot log reports. Approval uses the same glob syntax as
the allow-list, so the two policies read identically.

## Configuration

Resolution order is explicit config first, then the environment variable, then a
built-in default.

| Option                | Type                                              | Default                 | Description                                                                 |
| --------------------- | ------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `model`               | `string`                                          | resolved from fallbacks | Web-search endpoint: an endpoint name, a loose name, or a capability class. |
| `modelFallbacks`      | `string \| string[]`                              | Gemini, then GPT        | Ordered candidates tried when `model` is unset.                             |
| `webSearchTools`      | `Record<string, unknown>`                         | built-in provider map   | Provider -> tool-spec overrides, merged over the defaults.                  |
| `modelFuzzyMatch`     | `boolean`                                         | `true`                  | Fuzzy-match loose model names against the live catalogue.                   |
| `modelFuzzyThreshold` | `number`                                          | `0.4`                   | Fuse.js score below which a fuzzy match is accepted.                        |
| `maxCitations`        | `number`                                          | `10`                    | Hard cap on citations returned from one search.                             |
| `fetchMaxLength`      | `number`                                          | `50000`                 | Hard cap on `web_fetch` content length, in characters.                      |
| `timeoutMs`           | `number`                                          | `30000`                 | Per-request network timeout.                                                |
| `scrapeFallback`      | `boolean`                                         | `true`                  | Scrape DuckDuckGo when no web-search-capable model is deployed.             |
| `urlPolicy`           | `"unrestricted" \| "allowlist"`                   | follows `allowedUrls`   | Which URLs the tools may reach.                                             |
| `allowedUrls`         | `string \| string[]`                              | none                    | Allow-list globs or bare hosts.                                             |
| `approval`            | `boolean \| string \| string[] \| ApprovalPolicy` | `{ mode: "none" }`      | Default approval gate for both tools.                                       |

| Environment variable               | Sets                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `WEB_SEARCH_MODEL`                 | `model` (dedicated override, wins over the binding below)         |
| `DATABRICKS_SERVING_ENDPOINT_NAME` | `model` (AppKit's Model Serving binding, treated as a preference) |
| `WEB_SEARCH_MODEL_FALLBACKS`       | `modelFallbacks` (comma/space-separated)                          |
| `WEB_SEARCH_TOOLS`                 | `webSearchTools` (JSON object; anything else fails at boot)       |
| `WEB_SEARCH_FUZZY`                 | `modelFuzzyMatch`                                                 |
| `WEB_SEARCH_FUZZY_THRESHOLD`       | `modelFuzzyThreshold`                                             |
| `WEB_SEARCH_MAX_CITATIONS`         | `maxCitations`                                                    |
| `WEB_SEARCH_FETCH_MAX_LENGTH`      | `fetchMaxLength`                                                  |
| `WEB_SEARCH_TIMEOUT_MS`            | `timeoutMs`                                                       |
| `WEB_SEARCH_SCRAPE_FALLBACK`       | `scrapeFallback`                                                  |
| `WEB_SEARCH_URL_POLICY`            | `urlPolicy`                                                       |
| `WEB_SEARCH_ALLOWED_URLS`          | `allowedUrls` (comma/space-separated)                             |

The plugin's `maxCitations` / `fetchMaxLength` are hard caps: a per-call request
may narrow them but never exceed them.

Every outbound call - the serving POST, a page fetch, the scrape fallback -
runs through the plugin's `execute()` chain, so all three are cached, retried
with jittered backoff, timed out, and traced. The cache is namespaced per user,
so an on-behalf-of result never crosses identities. See `defaults.ts` for the
TTLs and retry budgets and why each was chosen.

Requirements: the native web-search tool runs on pay-per-token GPT / Gemini
serving endpoints with cross-region processing enabled; it is unavailable on
provisioned throughput, for external models, or under HIPAA/BAA compliance. See
the [Databricks docs](https://docs.databricks.com/aws/en/machine-learning/model-serving/web-search).

## Modules

- `plugin` - `WebSearchPlugin`, `webSearch()` AppKit plugin factory, and the
  AppKit `ToolProvider` implementation.
- `tool` - `webSearchTool()` / `webFetchTool()` Mastra tools.
- `defaults` - the cache / retry / timeout settings every outbound call runs
  with, and the reasoning behind each.
- `search` - `runWebSearch()` over the Databricks native web-search tool.
- `provider` - provider detection + the provider -> tool-spec map.
- `scrape` - `runScrapeSearch()` DuckDuckGo fallback for workspaces with no
  native web-search model.
- `fetch` - `runWebFetch()` over got-scraping.
- `html-text` - `htmlToText()` / `htmlFragmentToText()` / `decodeHtmlEntities()`, shared by
  `fetch` and the DuckDuckGo scrape fallback.
- `runtime` - shared runtime and the executor outbound calls run through:
  `getWebSearchRuntime()`, `setWebSearchExecutor()`, `executeRead()`,
  `resetWebSearchRuntime()`.
- `config` - config types, JSON schema, `resolveWebSearchConfig()`, URL policy
  and approval helpers.
- `allowlist` - URL allow-list parsing/compiling on top of `@dbx-tools/path`.
- `schema` - zod tool contracts and inferred types.

Pair this package with [`@dbx-tools/appkit-mastra`](../appkit-mastra) to spread
the tools into an agent (and resolve its own model via [`@dbx-tools/model`](../model)),
and [`@dbx-tools/email`](../email) for the sibling approval-gated tool pattern.
