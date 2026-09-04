import { Pool } from "pg";

import { bindings, postgres } from "../index.ts";

const address = process.argv[2];
if (!address || process.argv.length > 3) {
  console.error("usage: bun run packages/js/node/databricks-auth/test/cli.ts <postgres-host:port>");
  process.exit(2);
}

const separator = address.lastIndexOf(":");
const host = address.slice(0, separator);
const port = Number(address.slice(separator + 1));
if (!host || separator < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("postgres address must be host:port");
  process.exit(2);
}

const options = bindings.DatabricksAuthOptions.create({});
const pool = new Pool({
  host,
  port,
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres",
  database: process.env.PGDATABASE ?? "postgres",
});

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorMessage).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}

console.log(
  JSON.stringify({
    language: "node",
    profile: null,
    postgres: `${host}:${port}`,
    lockTimeoutSeconds: Number(options.lockTimeoutSeconds),
    loginTimeoutSeconds: Number(options.loginTimeoutSeconds),
    refreshBufferSeconds: Number(options.refreshBufferSeconds),
  }),
);

try {
  const connection = await pool.connect();
  connection.release();
  const auth = await bindings.createPersistentAuthWithStorage(
    options,
    postgres.createStorage(pool),
  );
  const status = auth.status();
  console.log(
    JSON.stringify({
      profile: status.profile,
      host: status.host,
      storage: "postgres",
    }),
  );
  const token = await auth.token();

  console.log(
    JSON.stringify({
      tokenType: token.tokenType,
      expiry: token.expiry,
      scopes: token.scopes,
    }),
  );
} catch (error) {
  const inner =
    error && typeof error === "object" && "inner" in error
      ? (error.inner as { message?: unknown }).message
      : undefined;
  console.error(errorMessage(inner ?? error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
