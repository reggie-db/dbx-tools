import { canonicalScopes, credentialKey } from "../index.ts";

const scopes = canonicalScopes(process.argv.slice(2));
console.log(
  JSON.stringify({
    provider: "example",
    profile: null,
    scopes,
    credentialKey: credentialKey("example", undefined, scopes),
  }),
);
