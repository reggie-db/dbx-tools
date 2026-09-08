import { createGoogleAuth, GoogleAuthOptions } from "../index.ts";

const auth = await createGoogleAuth(GoogleAuthOptions.create({}));
const status = auth.status();
console.log(
  JSON.stringify({
    credentialsPath: status.credentialsPath,
    storage: status.storage,
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
