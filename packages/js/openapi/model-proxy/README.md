# `@dbx-tools/openapi-model-proxy`

Generated OpenAPI 3.1 schema and `openapi-fetch` client for
`dbx-tools-model-proxy`.

## Key Features

- generated from the same aide and `axum-typed-routing` definitions used by the
  Rust server;
- typed REST paths for health, profile controls, rate-limit controls, and
  OpenAI-compatible model routes;
- browser-safe TypeScript types and an `openapi-fetch` client factory;
- generated and committed through `bun run openapi`.

## Use

```ts
import { createApiClient } from "@dbx-tools/openapi-model-proxy";

const client = createApiClient({
  baseUrl: "http://127.0.0.1:4000",
});
const { data } = await client.GET("/api/healthz");
```

State and live feeds use GraphQL at `/graphql`. Discover query and subscription
fields through GraphQL introspection or the configured GraphiQL examples. The preferred live
OpenAPI document is `/api/openapi.yaml`; JSON is available at
`/api/openapi.json`, and Scalar is served at `/api`.

Streaming `/v1` responses remain raw streams. `openapi-fetch` does not parse
server-sent events.
