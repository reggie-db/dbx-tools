const { U2mClient } = require("../index.js");

async function main() {
  const client = await U2mClient.create({
    profile: process.env.DATABRICKS_CONFIG_PROFILE,
  });
  const token = await client.tokenOrLogin();
  console.log({
    profile: client.status.profile,
    host: client.status.host,
    tokenType: token.tokenType,
    expiry: token.expiry,
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
