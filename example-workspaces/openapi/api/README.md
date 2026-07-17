# @dbx-tools/openapi-api

Generated OpenAPI client package for the example Express/tsoa server.

## Overview

`dbxtools openapi` generates this package from
`example-workspaces/server/api` controllers. The package contains the OpenAPI
spec, TypeScript schema types, and a small `openapi-fetch` client factory.

## Usage

```ts
import { client } from "@dbx-tools/openapi-api";

const api = client.createApiClient({ baseUrl: "http://localhost:3000" });
const result = await api.GET("/greeting/{name}", {
  params: { path: { name: "Ada" } },
});
```

## Modules

- `client` - `createApiClient(options)` wrapper around `openapi-fetch`.
- `schema` - generated OpenAPI TypeScript types, including `paths` and
  `components`.

The source of truth is the `tsoa` controller code, not this generated package.
