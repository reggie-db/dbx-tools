# `@dbx-tools/auth`

Databricks profile resolution and token or authentication-header production for
Node.js and Bun.

The package resolves profile configuration, selects PAT, M2M, CLI U2M, App
service-principal, or App OBO authentication, and coordinates token acquisition
in process memory. It does not own workspace HTTP APIs or construct Databricks
SDK clients.

## Features

- Standard `.databrickscfg` parsing and default-profile selection.
- Secret-free configured profile enumeration.
- CLI-backed U2M token and login commands.
- Direct PAT, M2M, App service-principal, and request-scoped App OBO tokens.
- Check-lock-recheck token acquisition and explicit token refresh.
- Authentication headers with the resolved workspace ID when available.
- No SDK, generic HTTP client, executable installer, or persistent token cache.

CLI-backed U2M requires an available `databricks` executable or an explicit
`DATABRICKS_CLI_PATH`. The Databricks CLI remains responsible for its own login
and credential persistence.

## Basic use

```ts
import { client, profile } from "@dbx-tools/auth";

const auth = await client.createAuthClient({ profile: "DEFAULT" });
const token = await auth.token();
const headers = await auth.headers();
const host = auth.host;
const profiles = profile.listProfiles();
```

`headers()` returns the authorization header and
`x-databricks-workspace-id` when the selected profile has a workspace ID. Pass
`{ login: false }` to token or authentication acquisition to disable
interactive login. Pass `{ refresh: true }` to bypass a reusable cached token.

Browser and UI code should import auth-type values, target values, profile
summaries, profile selections, and client-configuration schemas from
`@dbx-tools/shared-auth`.

## Consumer-owned clients

Capability packages should use the returned `AuthClient` directly:

```ts
const auth = await client.createAuthClient({ profile: "DEFAULT" });
const headers = await auth.headers();
```

Use those headers in a capability-specific request, or inject the token and host
into an AppKit or Databricks SDK workspace client. Keep request paths, payloads,
response parsing, and retry policy in the consuming package.

## Public modules

- `client` owns `createAuthClient`, `AuthClient`, access-token results, and
  token lifecycle operations.
- `config` owns secret-bearing profile options, lifecycle timing, and canonical
  header names.
- `profile` owns profile resolution and listing operations.

Provider, lifecycle, lock, and storage types are private implementation details.

## Debug logging

Set `LOG_LEVEL=debug` to trace profile selection, provider choice, credential
locks, cache reuse, token refresh, and login fallback. Logs never include access
tokens, refresh tokens, client secrets, authorization values, raw request
headers, or request bodies.
