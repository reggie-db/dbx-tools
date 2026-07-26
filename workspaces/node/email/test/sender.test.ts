import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedEmailConfig } from "../src/config";
import {
  assertSenderAllowed,
  deriveSenderAddress,
  isSenderAllowed,
  listSenderOptions,
  parseAllowedSenders,
  resolveSenderAddress,
} from "../src/sender";

/** A resolved outbox config with only the sender fields under test set. */
function outboxConfig(sender: Partial<ResolvedEmailConfig> = {}): ResolvedEmailConfig {
  return {
    mode: "file",
    outDir: "/tmp/email-outbox",
    allowedSenders: [],
    senderPolicy: "allowlist",
    ...sender,
  } as ResolvedEmailConfig;
}

describe("sender allow-list parsing", () => {
  it("accepts an array or a comma / whitespace separated string", () => {
    assert.deepEqual(parseAllowedSenders("a@x.com, b@x.com"), ["a@x.com", "b@x.com"]);
    assert.deepEqual(parseAllowedSenders("a@x.com b@x.com"), ["a@x.com", "b@x.com"]);
    assert.deepEqual(parseAllowedSenders(["a@x.com", "b@x.com"]), ["a@x.com", "b@x.com"]);
  });

  it("lower-cases, trims, and de-dupes", () => {
    assert.deepEqual(parseAllowedSenders(["  A@X.com ", "a@x.com"]), ["a@x.com"]);
  });

  it("yields nothing for an absent or empty value", () => {
    assert.deepEqual(parseAllowedSenders(undefined), []);
    assert.deepEqual(parseAllowedSenders("  ,  "), []);
  });
});

describe("sender allow-list matching", () => {
  it("matches an exact address case-insensitively", () => {
    assert.equal(isSenderAllowed("Alerts@Example.com", ["alerts@example.com"]), true);
    assert.equal(isSenderAllowed("other@example.com", ["alerts@example.com"]), false);
  });

  it("matches any local part on a wildcard or bare domain", () => {
    assert.equal(isSenderAllowed("alice@mail.example.com", ["*@mail.example.com"]), true);
    assert.equal(isSenderAllowed("bob@mail.example.com", ["mail.example.com"]), true);
    assert.equal(isSenderAllowed("alice@other.example.com", ["*@mail.example.com"]), false);
  });

  it("requires a local part for a domain pattern", () => {
    assert.equal(isSenderAllowed("@mail.example.com", ["*@mail.example.com"]), false);
  });

  it("treats a lone star as any address", () => {
    assert.equal(isSenderAllowed("anyone@anywhere.com", ["*"]), true);
  });

  it("permits everything when the effective list is empty", () => {
    assert.equal(isSenderAllowed("anyone@anywhere.com", []), true);
  });

  it("assertSenderAllowed rejects a denied address and passes a permitted one", () => {
    assert.throws(
      () => assertSenderAllowed("evil@attacker.com", ["*@mail.example.com"]),
      /Invalid value for from/,
    );
    assert.doesNotThrow(() => assertSenderAllowed("alice@mail.example.com", ["mail.example.com"]));
  });

  it("keeps the allow-list patterns out of the thrown message", () => {
    assert.throws(
      () => assertSenderAllowed("evil@attacker.com", ["*@mail.example.com"]),
      (err: Error) => !err.message.includes("mail.example.com"),
    );
  });
});

describe("sender derivation", () => {
  it("re-homes the user's local part on the sending domain", () => {
    assert.equal(
      deriveSenderAddress("alice@databricks.com", "mail.example.com"),
      "alice@mail.example.com",
    );
  });

  it("refuses to derive without an on-behalf-of user", () => {
    assert.throws(() => deriveSenderAddress(undefined, "mail.example.com"), /user email/);
    assert.throws(() => deriveSenderAddress("  ", "mail.example.com"), /user email/);
  });

  it("prefers an explicit From over the per-user derivation", () => {
    const config = outboxConfig({ from: "alerts@example.com", domain: "mail.example.com" });
    assert.equal(resolveSenderAddress(config, "alice@databricks.com"), "alerts@example.com");
  });

  it("derives from the domain when no explicit From is set", () => {
    const config = outboxConfig({ domain: "mail.example.com" });
    assert.equal(resolveSenderAddress(config, "alice@databricks.com"), "alice@mail.example.com");
  });

  it("falls back to the user's own address when neither is configured", () => {
    assert.equal(
      resolveSenderAddress(outboxConfig(), "alice@databricks.com"),
      "alice@databricks.com",
    );
  });

  it("refuses when no source and no user yield an address", () => {
    assert.throws(() => resolveSenderAddress(outboxConfig(), undefined), /Email sender address/);
  });
});

describe("sender options for a picker", () => {
  it("offers the default sender first", () => {
    const config = outboxConfig({
      domain: "mail.example.com",
      allowedSenders: ["alerts@example.com", "*@mail.example.com"],
    });
    assert.deepEqual(listSenderOptions(config, "alice@databricks.com"), [
      "alice@mail.example.com",
      "alerts@example.com",
    ]);
  });

  it("expands a domain pattern against the user's local part", () => {
    const config = outboxConfig({ allowedSenders: ["*@mail.example.com", "other.example.com"] });
    assert.deepEqual(listSenderOptions(config, "alice@databricks.com"), [
      "alice@mail.example.com",
      "alice@other.example.com",
    ]);
  });

  it("drops domain patterns when there is no user local part to expand with", () => {
    const config = outboxConfig({ allowedSenders: ["*@mail.example.com"] });
    assert.deepEqual(listSenderOptions(config, undefined), []);
  });

  it("cannot enumerate a lone star, so it offers only the default", () => {
    const config = outboxConfig({ from: "alerts@example.com", allowedSenders: ["*"] });
    assert.deepEqual(listSenderOptions(config, "alice@databricks.com"), ["alerts@example.com"]);
  });

  it("omits a default the allow-list does not permit", () => {
    const config = outboxConfig({
      from: "alerts@example.com",
      allowedSenders: ["*@mail.example.com"],
    });
    assert.deepEqual(listSenderOptions(config, "alice@databricks.com"), ["alice@mail.example.com"]);
  });
});
