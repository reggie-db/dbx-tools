# @dbx-tools/shared-sdk-model

Generated zod schemas for selected Databricks SDK model types.

Import this package when shared code needs runtime validation for upstream
Databricks API shapes without importing the Databricks SDK itself. The generated
schemas are browser-safe and are consumed by higher-level packages such as
[`@dbx-tools/shared-genie`](../genie).

Key features:

- Generated zod schemas for selected Databricks SDK model declarations.
- Flat inferred TypeScript types hoisted from generated modules.
- Browser-safe validation for UI and shared packages that should not import SDK
  clients.
- Read-only generated source managed by `@dbx-tools/projen` codegen inputs.

## Validate SDK-Shaped Data

```ts
import { dashboards } from "@dbx-tools/shared-sdk-model";

const message = dashboards.genieMessageSchema.parse(rawMessage);
const space = dashboards.genieSpaceSchema.parse(rawSpace);
```

The `dashboards` namespace contains generated schemas and inferred types for
Dashboard and Genie types from the Databricks SDK experimental dashboards model.

## Use Generated Types

```ts
import { type GenieMessage, type GenieSpace } from "@dbx-tools/shared-sdk-model";

function summarize(message: GenieMessage, space: GenieSpace) {
  return `${space.title}: ${message.status}`;
}
```

Types are hoisted flat from the generated module while schemas stay under the
`dashboards` namespace.

## Regeneration

The package `package.json` declares `codegen.inputs`. During `pnpm exec projen`,
`@dbx-tools/projen` reads those `.d.ts` files, emits zod schemas to
`src/<name>.ts`, and regenerates the barrel.

Generated files are read-only. Change the codegen input or generator, then run
synth; do not hand-edit `src/dashboards.ts`.

Codegen is intentionally narrow: this package should contain SDK shapes that
other packages actually validate at runtime. Add new inputs when a shared
package needs a stable browser-safe schema for a Databricks API payload.

## Module

- `dashboards` - generated Dashboard and Genie request/response/entity schemas
  plus inferred types.

For widened Genie event contracts, use
[`@dbx-tools/shared-genie`](../genie).
