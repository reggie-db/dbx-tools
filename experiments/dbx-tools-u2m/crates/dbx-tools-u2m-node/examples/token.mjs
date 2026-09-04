import { createPersistentAuth, U2mOptions } from "../dist/index.js";

const auth = await createPersistentAuth(
  U2mOptions.create({ profile: process.env.DATABRICKS_CONFIG_PROFILE }),
);
const token = await auth.token();
const status = auth.status();
console.log({
  profile: status.profile,
  host: status.host,
  tokenType: token.tokenType,
  expiry: token.expiry,
});
