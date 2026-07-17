# @dbx-tools/server-appkit-server

Minimal Databricks AppKit server example.

## Overview

This package shows a small `@databricks/appkit` backend using the built-in
`server()` plugin and an extended Express route.

## Usage

Run from this package directory:

```sh
pnpm dev
```

The server registers:

```text
GET /api/health
```

## Module

- `server` - calls AppKit `createApp({ plugins: [server()] })` and adds the
  health route in `onPluginsReady`.

Use this example when checking that the repo's server tag and AppKit catalog
dependency are wired correctly.
