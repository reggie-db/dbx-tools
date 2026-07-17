# @dbx-tools/shared-mastra

Browser-safe wire contract, embed-marker grammar, and route segments for the
Mastra add-on's `clientConfig()` surface. Pure zod - no `pg`, no Mastra runtime
- so the React client and any browser bundle import these without dragging in
server-only deps.

```ts
import { wire, marker, routes } from "@dbx-tools/shared-mastra";

const cfg = wire.MastraClientConfigSchema.parse(raw);
const markers = marker.parseMarkers(text);       // embed-marker grammar
const url = `${cfg.basePath}${routes.MASTRA_ROUTES.history}`;
```

## Modules

- `wire` - client config, history / thread / suggestion / serving responses, and
  the Genie agent event stream (extends `shared-genie` + `shared-model` schemas).
- `marker` - the `[[embed:...]]` marker grammar (`parseMarkers`, `isUuid`).
- `feedback` - MLflow feedback request/response + header names.
- `override` - model / thread override header + query/body field names.
- `routes` - the `MASTRA_ROUTES` segment map.
- `thread` - thread-id header / query names.

Server-side agents + plugin live in `@dbx-tools/node-mastra`.
