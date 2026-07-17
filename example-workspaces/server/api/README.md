# @dbx-tools/server-api

Example Express/tsoa server package.

## Overview

This package exposes a tiny greeting API and demonstrates how server packages
feed `dbxtools openapi`. The controller decorators and TypeScript response types
are the source of truth for the generated OpenAPI package.

## Usage

Run from this package directory:

```sh
pnpm dev
```

The server listens on port `3000` and exposes:

```text
GET /greeting/{name}
```

## Modules

- `server` - creates and starts the Express app.
- `greetingController` - `tsoa` controller and `Greeting` response type used by
  OpenAPI generation.

Generated client output lives in `example-workspaces/openapi/api`.
