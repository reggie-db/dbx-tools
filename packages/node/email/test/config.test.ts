import assert from "node:assert/strict";
import { resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_SMTP_PORT,
  IMPLICIT_TLS_SMTP_PORT,
  resolveEmailConfig,
  type ResolvedSmtpConfig,
  type SenderPolicy,
} from "../src/config.ts";

/** Every env var {@link resolveEmailConfig} reads, cleared between cases. */
const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "EMAIL_DOMAIN",
  "EMAIL_FROM",
  "EMAIL_ALLOWED_SENDERS",
  "EMAIL_SENDER_POLICY",
  "EMAIL_OUTBOX_MODE",
  "EMAIL_OUTBOX_DIR",
] as const;

const SMTP_CREDENTIALS = {
  host: "smtp.example.com",
  user: "apikey",
  password: "secret",
} as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveEmailConfig modes", () => {
  it("refuses to resolve with neither SMTP credentials nor an outbox opt-in", () => {
    assert.throws(() => resolveEmailConfig(), /SMTP connection not configured/);
  });

  it("names the missing env vars for a partial SMTP configuration", () => {
    assert.throws(
      () => resolveEmailConfig({ smtp: { host: "smtp.example.com" } }),
      /Missing required environment variables: SMTP_USER, SMTP_PASSWORD/,
    );
  });

  it("refuses SMTP with no sender source to derive a From from", () => {
    assert.throws(() => resolveEmailConfig({ smtp: SMTP_CREDENTIALS }), /Email sender source/);
  });

  it("resolves SMTP mode with the default port and STARTTLS", () => {
    const config = resolveEmailConfig({
      smtp: SMTP_CREDENTIALS,
      domain: "mail.example.com",
    }) as ResolvedSmtpConfig;
    assert.equal(config.mode, "smtp");
    assert.equal(config.port, DEFAULT_SMTP_PORT);
    assert.equal(config.secure, false);
    assert.deepEqual(config.auth, { user: "apikey", pass: "secret" });
  });

  it("turns on TLS-on-connect for the implicit-TLS port", () => {
    const config = resolveEmailConfig({
      smtp: { ...SMTP_CREDENTIALS, port: IMPLICIT_TLS_SMTP_PORT },
      domain: "mail.example.com",
    }) as ResolvedSmtpConfig;
    assert.equal(config.secure, true);
  });

  it("prefers explicit config over the matching env var", () => {
    process.env.SMTP_HOST = "env.example.com";
    process.env.SMTP_PORT = "2525";
    process.env.SMTP_USER = "envuser";
    process.env.SMTP_PASSWORD = "envpass";
    process.env.EMAIL_DOMAIN = "env.example.com";
    const config = resolveEmailConfig({
      smtp: SMTP_CREDENTIALS,
      domain: "mail.example.com",
    }) as ResolvedSmtpConfig;
    assert.equal(config.host, "smtp.example.com");
    assert.equal(config.domain, "mail.example.com");
    // The port has no explicit value, so the env var still wins over the default.
    assert.equal(config.port, 2525);
  });

  it("resolves outbox mode to an absolute directory when opted in", () => {
    process.env.EMAIL_OUTBOX_MODE = "1";
    const config = resolveEmailConfig({ outDir: "tmp/email-outbox" });
    assert.equal(config.mode, "file");
    assert.equal(config.mode === "file" && config.outDir, resolve("tmp/email-outbox"));
  });

  it("keeps a sender source optional in outbox mode", () => {
    process.env.EMAIL_OUTBOX_MODE = "1";
    const config = resolveEmailConfig();
    assert.equal(config.mode, "file");
    assert.equal(config.domain, undefined);
    assert.equal(config.from, undefined);
  });
});

describe("resolveEmailConfig sender policy", () => {
  it("defaults to allowlist and narrows an empty list to the configured domain", () => {
    const config = resolveEmailConfig({ smtp: SMTP_CREDENTIALS, domain: "mail.example.com" });
    assert.equal(config.senderPolicy, "allowlist");
    assert.deepEqual(config.allowedSenders, ["*@mail.example.com"]);
  });

  it("narrows an empty list to a fixed From when that is the sender source", () => {
    const config = resolveEmailConfig({ smtp: SMTP_CREDENTIALS, from: "Alerts@Example.com" });
    assert.deepEqual(config.allowedSenders, ["alerts@example.com"]);
  });

  it("includes both patterns when both sender sources are configured", () => {
    const config = resolveEmailConfig({
      smtp: SMTP_CREDENTIALS,
      from: "alerts@example.com",
      domain: "mail.example.com",
    });
    assert.deepEqual(config.allowedSenders, ["alerts@example.com", "*@mail.example.com"]);
  });

  it("leaves the list empty under the named unrestricted policy", () => {
    const config = resolveEmailConfig({
      smtp: SMTP_CREDENTIALS,
      domain: "mail.example.com",
      senderPolicy: "unrestricted",
    });
    assert.equal(config.senderPolicy, "unrestricted");
    assert.deepEqual(config.allowedSenders, []);
  });

  it("reads the policy from EMAIL_SENDER_POLICY", () => {
    process.env.EMAIL_SENDER_POLICY = "unrestricted";
    const config = resolveEmailConfig({ smtp: SMTP_CREDENTIALS, domain: "mail.example.com" });
    assert.equal(config.senderPolicy, "unrestricted");
  });

  it("rejects an unrecognized policy", () => {
    const senderPolicy = "open" as SenderPolicy;
    assert.throws(
      () => resolveEmailConfig({ smtp: SMTP_CREDENTIALS, domain: "d.com", senderPolicy }),
      /Invalid value for senderPolicy/,
    );
  });

  it("keeps an explicit allow-list instead of the implied one", () => {
    const config = resolveEmailConfig({
      smtp: SMTP_CREDENTIALS,
      domain: "mail.example.com",
      allowedSenders: "Alerts@Example.com, *@other.example.com",
    });
    assert.deepEqual(config.allowedSenders, ["alerts@example.com", "*@other.example.com"]);
  });

  it("reads an explicit allow-list from EMAIL_ALLOWED_SENDERS", () => {
    process.env.EMAIL_OUTBOX_MODE = "1";
    process.env.EMAIL_ALLOWED_SENDERS = "a@x.com b@x.com";
    assert.deepEqual(resolveEmailConfig().allowedSenders, ["a@x.com", "b@x.com"]);
  });
});
