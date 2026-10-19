# @dbx-tools/appkit-generator

Generate researched brand contexts or provision a governed Databricks demo
environment from business questions. The package exposes every operation as an
AppKit tool and composes them through a registered Mastra workflow.

## Register the plugin

Register `webSearch()`, `generator()`, and `mastra()` in the same AppKit application:

```ts
import { createApp, server } from "@databricks/appkit";
import { generator } from "@dbx-tools/appkit-generator";
import { webSearch } from "@dbx-tools/appkit-web-search";
import { mastra } from "@dbx-tools/appkit-mastra";

const appkit = await createApp({
  plugins: [server(), webSearch(), mastra(), generator()],
});

const generated = await appkit.generator.generateBrand({
  name: "Databricks",
  website: "https://www.databricks.com/",
});

const { brand: brandContext, sources } = generated;
```

The generated package contains:

- Canonical and short names, tagline, and description.
- Application colors and CSS font stacks.
- Audience, tone, writing principles, and patterns to avoid.
- Official website, documentation, and repository links when found.
- Logo, icon, and favicon URLs discovered from official page markup.
- Supplemental iOS and Android app references used for visual direction.
- Source provenance, including whether each cited page was fetched.

The optional website disambiguates similarly named brands and is placed first
in the source candidates. Omit it when the brand has one clear public identity.

## Give the tools to an agent

The plugin implements AppKit's `ToolProvider`. A native AppKit agent can opt in
to individual generator tools:

```ts
import { createAgent } from "@databricks/appkit/beta";

export default createAgent({
  name: "Brand researcher",
  model: "databricks-gpt-6-1-sol",
  instructions: "Research and generate approved Databricks demo assets.",
  tools: (plugins) => ({ ...plugins.generator.toolkit({ prefix: "" }) }),
});
```

Read-only tools cover brand and KPI research plus typed planning. Mutating tools
provision schemas, materialize data, and create dashboard or Genie assets under
the requesting user's OBO context. They are never auto-inherited.

## Stream progress in a browser

The plugin publishes its mounted base path through `clientConfig()` and serves
`POST /generate` as Server-Sent Events. Use the browser-safe client instead of
hard-coding the route:

```ts
import {
  GENERATOR_PLUGIN_NAME,
  GeneratorPluginClient,
  type GeneratorClientConfig,
} from "@dbx-tools/shared-generator/brand";
import { usePluginClientConfig } from "@dbx-tools/ui/react";

const config = usePluginClientConfig<GeneratorClientConfig>(GENERATOR_PLUGIN_NAME);
const client = new GeneratorPluginClient(config);

for await (const event of client.generate({ name: "Databricks" })) {
  if (event.type === "progress") updateActivity(event);
  if (event.type === "result") applyBrand(event.package.brand);
}
```

Progress stages report source search, page fetches, asset inspection, and
structured synthesis. The terminal result includes the generated context and
source provenance.

## Run the demo-asset workflow

The registered `generatorDemoAssets` Mastra workflow accepts a company, purpose,
business questions, presentation mode, and bounded row count. It:

1. Researches brand assets and KPIs from cited web sources.
2. Produces a Zod-validated data plan without model-authored SQL.
3. Suspends for approval before any mutation.
4. Has the app service principal create and mark a deterministic per-user schema.
5. Grants the active OBO user `ALL_PRIVILEGES` and `MANAGE`.
6. Materializes deterministic Delta data and validates every KPI.
7. Publishes an AI/BI dashboard with automatic companion Genie, or creates one
   standalone Genie space when dashboard mode is not requested.

Schema names derive from the trusted user name, company, and purpose. Ownership
markers prevent a slug collision from adopting another user's schema.

## How brand generation works

One request performs the following bounded workflow:

1. `web_search` asks for first-party identity, voice, visual, and link evidence.
2. Separate searches find relevant iOS App Store and Google Play listings.
3. `web_fetch` reads up to four cited pages by default and visits matching app
   listings for supplemental visual references.
4. The likely official page is also fetched as HTML for deterministic logo,
   icon, and favicon discovery.
5. Representative app icons and screenshots are fetched and included in the
   structured model call with the broader web evidence.
6. The package normalizes action and text colors to WCAG AA contrast, then
   `BrandContextSchema` validates the final portable context.

Fetched page text is treated as untrusted reference data. Embedded instructions
are excluded from the synthesis instructions. Link fields must use URLs present
in the research evidence. Asset URLs come from the official page markup, with
`/favicon.ico` on that origin as the icon fallback.

The package returns official brand asset URLs and mobile-reference metadata.
Mobile images are held in memory during synthesis so an exporter can persist
them separately as references. They are not substituted for the generated
brand identity and the package does not grant rights to third-party artwork.

## Configure generation

Pass options to `brand()`:

```ts
generator({
  model: "databricks-claude-sonnet-4-6",
  catalog: "main",
  warehouseId: "abc123",
  maxSources: 6,
  sourceMaxLength: 12_000,
  timeoutMs: 180_000,
});
```

`model` accepts a deployed endpoint name or loose model request resolved by
`@dbx-tools/appkit-mastra`. When omitted, the live workspace model resolver
selects the endpoint.

The equivalent environment variables are:

- `GENERATOR_MODEL`
- `GENERATOR_CATALOG`
- `GENERATOR_MAX_SOURCES`
- `GENERATOR_SOURCE_MAX_LENGTH`
- `GENERATOR_TIMEOUT_MS`
- `DATABRICKS_WAREHOUSE_ID`

The source count is capped at eight and each excerpt at 20,000 characters.
Whole-package results are cached for six hours per AppKit execution identity.
Search and page reads keep the independent cache, retry, timeout, and URL-policy settings owned by
`@dbx-tools/appkit-web-search`.

## Use the result

Apply the generated context with the shared React branding provider:

```tsx
import type { BrandContext } from "@dbx-tools/shared-core/brand-utils";
import { BrandProvider } from "@dbx-tools/ui/branding/react";

export function App({ brand }: { brand: BrandContext }) {
  return (
    <BrandProvider context={brand} applyToDocument>
      <Application />
    </BrandProvider>
  );
}
```

The same context can be converted for delivered email with
`emailBrandFromContext` from `@dbx-tools/shared-email-template`.
