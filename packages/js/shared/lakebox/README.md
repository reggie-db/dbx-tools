# @dbx-tools/shared-lakebox

Browser-safe Zod contracts and route builders for the app Lakebox: lifecycle
summaries, the current user's account, services, commands, logs, and metrics.

## Validate a service definition

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

For a routed service, the process inside the image must listen on
`127.0.0.1:$SERVICE_PORT`. The schema doesn't support Docker-style port
publishing, privileged mode, devices, or absolute host mount paths.

## Build API and service URLs

Accept the plugin's published client configuration as an input and derive every
route from the shared constants:

```ts
import { LAKEBOX_ROUTES, lakeboxRoute, type LakeboxClientConfig } from "@dbx-tools/shared-lakebox";
import { lakeboxServicePath } from "@dbx-tools/shared-lakebox/client";

export function lakeboxUrls(config: LakeboxClientConfig, userHash: string, serviceName: string) {
  return {
    start: `${config.basePath}${lakeboxRoute(LAKEBOX_ROUTES.serviceStart, {
      name: serviceName,
    })}`,
    open: lakeboxServicePath(config.routePrefix, userHash, serviceName),
  };
}
```

Read `basePath` and `routePrefix` from the plugin's published client config and
derive every endpoint from `LAKEBOX_ROUTES`. Service routes are
`<routePrefix>/<user hash>/<service>`.

## Validate server responses

Parse server responses before storing or rendering them:

```ts
import {
  LAKEBOX_ROUTES,
  lakeboxMetricsResponseSchema,
  lakeboxSummarySchema,
  type LakeboxClientConfig,
} from "@dbx-tools/shared-lakebox";

export async function readLakebox(config: LakeboxClientConfig) {
  const [statusResponse, metricsResponse] = await Promise.all([
    fetch(`${config.basePath}${LAKEBOX_ROUTES.status}`),
    fetch(`${config.basePath}${LAKEBOX_ROUTES.metrics}`),
  ]);
  return {
    summary: lakeboxSummarySchema.parse(await statusResponse.json()),
    metrics: lakeboxMetricsResponseSchema.parse(await metricsResponse.json()),
  };
}
```

The contracts cover lifecycle state, service state, bounded logs, command
results, and machine-level CPU, memory, storage, and network metrics. They
don't contain Databricks credentials or request identity tokens.

## Use the contract boundaries

- `LAKEBOX_ROUTES` contains plugin API templates. Use `lakeboxRoute()` to encode
  named route parameters.
- `lakeboxServicePath()` builds the authenticated reverse-proxy route for one
  user and service.
- `CreateLakeboxServiceRequest` is the caller input type.
  `LakeboxServiceDefinition` is the parsed type with defaults applied.
- Log requests default to 200 lines and 16,000 characters.
- Service names `terminal` and `desktop` are reserved for built-in services.
- The browser contract doesn't implement lifecycle, authentication, SSH, or
  React state. Those capabilities live in the Node and UI packages.
