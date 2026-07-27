import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { EmailMessage } from "@dbx-tools/shared-email";
import { EMAIL_SEND_SETTINGS, type EmailExecutionSettings } from "../src/defaults";
import {
  getEmailRuntime,
  resetEmailRuntime,
  sendEmail,
  setEmailExecutor,
  type EmailExecutor,
} from "../src/transport";

// The runtime is a process-wide singleton built from the environment on first
// use, so the outbox mode has to be in place before any test sends.
process.env.EMAIL_OUTBOX_MODE = "1";
process.env.EMAIL_OUTBOX_DIR = mkdtempSync(join(tmpdir(), "email-executor-"));
process.env.EMAIL_ALLOWED_SENDERS = "*@example.com";

const FROM = "alerts@example.com";

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return { to: ["alice@example.com"], subject: "Subject", body: "Body", ...overrides };
}

/** One recorded call to a spying executor. */
interface Recorded {
  settings: EmailExecutionSettings;
}

/**
 * An executor that records what it was handed and runs the call, standing in
 * for the plugin's `execute()`. `supplied` is the signal it hands the call,
 * mirroring the one the timeout interceptor provides.
 */
function spyExecutor(calls: Recorded[], supplied?: AbortSignal): EmailExecutor {
  return async (fn, settings) => {
    calls.push({ settings });
    try {
      return { ok: true, data: await fn(supplied) };
    } catch (err) {
      return { ok: false, status: 500, message: err instanceof Error ? err.message : "failed" };
    }
  };
}

// Dropping the runtime also drops the installed executor, so each case starts
// on the unregistered fallback.
afterEach(() => resetEmailRuntime());

describe("send executor registration", () => {
  it("sends without a registered plugin, through the direct fallback", async () => {
    const result = await sendEmail(message(), FROM);
    assert.equal(result.sent, true);
    assert.ok(result.messageId?.endsWith(".html"));
  });

  it("installs the supplied executor on the shared runtime", () => {
    const replacement: EmailExecutor = async (fn) => ({ ok: true, data: await fn() });
    const fallback = getEmailRuntime().execute;
    setEmailExecutor(replacement);
    assert.notEqual(fallback, replacement);
    assert.equal(getEmailRuntime().execute, replacement);
  });

  it("routes a send through the installed executor", async () => {
    const calls: Recorded[] = [];
    setEmailExecutor(spyExecutor(calls));
    const result = await sendEmail(message(), FROM);
    assert.equal(result.sent, true);
    assert.equal(calls.length, 1);
  });

  it("hands the executor the write settings, so cache and retry stay off", async () => {
    const calls: Recorded[] = [];
    setEmailExecutor(spyExecutor(calls));
    await sendEmail(message(), FROM);
    assert.equal(calls[0]!.settings, EMAIL_SEND_SETTINGS);
    assert.equal(calls[0]!.settings.default.cache?.enabled, false);
    assert.equal(calls[0]!.settings.default.retry?.enabled, false);
  });

  it("replaces the previous executor so a re-registered plugin is not stale", async () => {
    const first: Recorded[] = [];
    const second: Recorded[] = [];
    setEmailExecutor(spyExecutor(first));
    setEmailExecutor(spyExecutor(second));
    await sendEmail(message(), FROM);
    assert.equal(first.length, 0);
    assert.equal(second.length, 1);
  });

  it("stops using an executor once the runtime is dropped", async () => {
    const calls: Recorded[] = [];
    setEmailExecutor(spyExecutor(calls));
    resetEmailRuntime();
    await sendEmail(message(), FROM);
    assert.equal(calls.length, 0);
  });
});

describe("send executor failure handling", () => {
  it("raises a stable error that does not leak the upstream message", async () => {
    setEmailExecutor(async () => ({ ok: false, status: 502, message: "relay said 5.7.1 nope" }));
    await assert.rejects(
      () => sendEmail(message(), FROM),
      (err: Error) => {
        assert.match(err.message, /email: send failed/);
        assert.doesNotMatch(err.message, /5\.7\.1/);
        return true;
      },
    );
  });

  it("keeps validation ahead of the chain, so the executor never runs", async () => {
    const calls: Recorded[] = [];
    setEmailExecutor(spyExecutor(calls));
    await assert.rejects(() => sendEmail(message({ to: [] }), FROM), /Missing required field: to/);
    await assert.rejects(() => sendEmail(message(), "evil@attacker.com"), /Invalid value for from/);
    assert.equal(calls.length, 0);
  });
});

describe("send executor user scoping", () => {
  it("reads the caller scope in force at send time, not at registration time", async () => {
    // Stands in for AppKit's executionContextStorage: `asUser(req)` wraps the
    // dispatch in `runInUserContext`, an AsyncLocalStorage.run, so an executor
    // registered once at setup still resolves the per-call identity.
    const storage = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    setEmailExecutor(async (fn) => {
      seen.push(storage.getStore());
      return { ok: true, data: await fn() };
    });
    await storage.run("alice@databricks.com", () => sendEmail(message(), FROM));
    await sendEmail(message(), FROM);
    assert.deepEqual(seen, ["alice@databricks.com", undefined]);
  });
});

describe("send executor cancellation", () => {
  it("honors the signal the executor supplies", async () => {
    const calls: Recorded[] = [];
    setEmailExecutor(spyExecutor(calls, AbortSignal.abort()));
    await assert.rejects(() => sendEmail(message(), FROM), /email: send failed/);
    assert.equal(calls.length, 1);
  });

  it("honors the caller's own signal on the direct fallback", async () => {
    await assert.rejects(() => sendEmail(message(), FROM, AbortSignal.abort()), /cancel/i);
  });

  it("honors the caller's signal when the executor supplies a live one", async () => {
    const calls: Recorded[] = [];
    setEmailExecutor(spyExecutor(calls, new AbortController().signal));
    await assert.rejects(() => sendEmail(message(), FROM, AbortSignal.abort()), /cancel/i);
    assert.equal(calls.length, 1);
  });
});
