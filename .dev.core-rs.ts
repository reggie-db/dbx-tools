import { createPersistentAuth, DatabricksAuthOptions } from "@dbx-tools/core-rs";

function _decodeJwt(value: string): { header: unknown; payload: unknown } | undefined {
  const segments = value.split(".");
  if (segments.length !== 3) return undefined;
  return {
    header: JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8")) as unknown,
    payload: JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown,
  };
}


const auth = await createPersistentAuth(
  DatabricksAuthOptions.create({ profile: process.argv[2] }),
);
const token = await auth.token();

console.log(
  JSON.stringify(
    {
      status: auth.status(),
      token: {
        tokenType: token.tokenType,
        expiry: token.expiry,
        scopes: token.scopes,
        unverifiedJwt: _decodeJwt(token.accessToken),
      },
    },
    null,
    2,
  ),
);
