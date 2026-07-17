# @dbx-tools/shared-sdk-model

Zod schemas plus inferred TypeScript types for the Databricks SDK shapes the
rest of the `@dbx-tools/*` packages consume. Everything under `src/` is
**generated** from the upstream `@databricks/sdk-experimental` `.d.ts`
declarations by `dbxtools codegen` (see [`@dbx-tools/projen`](../../node/projen));
nothing here is hand-maintained. Browser-safe (zod only).

```ts
import { dashboards } from "@dbx-tools/shared-sdk-model";

const message = dashboards.genieMessageSchema.parse(rawJson);
```

The generated module is namespaced on the barrel (`dashboards`), so schemas are
reached as `dashboards.genieMessageSchema`, `dashboards.messageStatusSchema`,
etc. Regeneration runs as part of `pnpm exec projen` (synth): the `codegen`
field in `package.json` names the upstream `.d.ts` inputs, each written to a
read-only `src/<name>.ts`.
