# @dbx-tools/shared-lakebox

Browser-safe Zod contracts and route builders for the app Lakebox: lifecycle
summaries, the current user's account, services, commands, logs, and metrics.

## Validate a service request

```ts
import { createLakeboxServiceRequestSchema } from "@dbx-tools/shared-lakebox";

const request = createLakeboxServiceRequestSchema.parse({
  name: "hello",
  image: "docker.io/library/python:3.12-alpine",
});
```

Parsing applies defaults (`route: true`, `stripPrefix: true`,
`pull: "missing"`) and rejects reserved variables (`SERVICE_NAME`,
`SERVICE_PATH`, `SERVICE_PORT`, `PORT`), Databricks credentials, built-in
service names, and mount sources outside the user's home.

## Build plugin URLs

```ts
import { LAKEBOX_ROUTES, lakeboxRoute } from "@dbx-tools/shared-lakebox";
import { lakeboxServicePath } from "@dbx-tools/shared-lakebox/client";

const start = `${basePath}${lakeboxRoute(LAKEBOX_ROUTES.serviceStart, { name: "hello" })}`;
const open = lakeboxServicePath(routePrefix, user.hash, "hello");
```

Read `basePath` and `routePrefix` from the plugin's published client config and
derive every endpoint from `LAKEBOX_ROUTES`. Service routes are
`<routePrefix>/<user hash>/<service>`.
