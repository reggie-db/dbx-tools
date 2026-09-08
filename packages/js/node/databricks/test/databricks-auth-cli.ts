import { createPersistentAuth, DatabricksAuthOptions } from "../index.ts";

const auth = await createPersistentAuth(DatabricksAuthOptions.create({ profile: process.argv[2] }));
console.log(JSON.stringify(auth.status()));
const token = await auth.token();
console.log(
  JSON.stringify({ tokenType: token.tokenType, expiry: token.expiry, scopes: token.scopes }),
);
