import { SignJWT } from "jose";
const email = "reggie.pierce@databricks.com";
console.log(
  await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setAudience("dbx-tools-tunnel-auth")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(process.env.SECRET)),
);
