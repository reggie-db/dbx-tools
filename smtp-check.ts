import { config, sender, transport } from "./packages/node/email/index.ts";
import { codeEmailHtmlBody, codeEmailTextBody } from "./packages/cli/tunnel/src/app.ts";

const get = async (k: string) => {
  const p = Bun.spawnSync(["databricks","secrets","get-secret","dbx-tools-demo",k,"--profile","FEVM-REGGIE-PIERCE-AWS"]);
  return Buffer.from(JSON.parse(p.stdout.toString()).value, "base64").toString();
};
for (const [env, key] of [["SMTP_HOST","smtp-host"],["SMTP_PORT","smtp-port"],["SMTP_SECURE","smtp-secure"],["SMTP_USER","smtp-user"],["SMTP_PASSWORD","smtp-password"],["EMAIL_DOMAIN","email-domain"]] as const) {
  process.env[env] = await get(key);
}
delete process.env.EMAIL_FROM;
delete process.env.EMAIL_SYSTEM_FROM;

const resolved = config.resolveEmailConfig();
const from = sender.resolveSystemSenderAddress(resolved);
console.log("mode:", resolved.mode, "| system from:", from, "| allow:", resolved.allowedSenders);

const code = String(Math.floor(100000 + Math.random() * 900000));
const opts = { message: "Your verification code is:", codeTtlSeconds: 600 };
const result = await transport.sendEmail(
  { to: ["reggie.pierce@databricks.com"], subject: "Your verification code", body: codeEmailHtmlBody(code, opts) },
  from,
  undefined,
  { text: codeEmailTextBody(code, opts) },
);
console.log("RESULT:", result);
console.log("code:", code);
