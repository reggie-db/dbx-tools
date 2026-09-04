# dbx-tools-u2m Node bindings

N-API bindings for the Rust U2M client. Methods return native JavaScript promises and reuse the same Databricks environment, profile, keyring, plaintext-cache, and locking behavior as the core crate.

Build and run the example:

```bash
npm install
npm run build
DATABRICKS_CONFIG_PROFILE=DEFAULT npm run example
```

```js
const { U2mClient } = require("@dbx-tools/u2m-native");

const client = await U2mClient.create({ profile: "DEFAULT" });
const token = await client.tokenOrLogin();
const response = await fetch(`${client.status.host}/api/2.0/clusters/list`, {
  headers: { Authorization: `${token.tokenType} ${token.accessToken}` },
});
```

Compile the crate with Cargo feature `postgres` and pass `postgresUrl` to use the optional Postgres adapter.
