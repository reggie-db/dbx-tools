import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EmailAttachment, EmailMessage } from "@dbx-tools/shared-email";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_BODY_CHARS,
} from "../src/defaults";
import { resetEmailRuntime, sendEmail } from "../src/transport";

// The runtime is a process-wide singleton built from the environment on first
// use, so the outbox mode has to be in place before any test sends.
const OUTBOX_DIR = mkdtempSync(join(tmpdir(), "email-outbox-"));
process.env.EMAIL_OUTBOX_MODE = "1";
process.env.EMAIL_OUTBOX_DIR = OUTBOX_DIR;
process.env.EMAIL_ALLOWED_SENDERS = "*@example.com";

const FROM = "alerts@example.com";

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return { to: ["alice@example.com"], subject: "Subject", body: "Body", ...overrides };
}

/** An attachment whose inline content decodes to exactly `bytes` bytes. */
function attachment(filename: string, bytes: number): EmailAttachment {
  return { filename, content: "x".repeat(bytes) };
}

after(() => resetEmailRuntime());

describe("send validation", () => {
  it("rejects a message with no recipient", async () => {
    await assert.rejects(() => sendEmail(message({ to: [] }), FROM), /Missing required field: to/);
  });

  it("rejects a body over the character cap", async () => {
    await assert.rejects(
      () => sendEmail(message({ body: "x".repeat(MAX_BODY_CHARS + 1) }), FROM),
      /Invalid value for body/,
    );
  });

  it("rejects a single attachment over the per-file byte cap", async () => {
    const attachments = [attachment("big.bin", MAX_ATTACHMENT_BYTES + 1)];
    await assert.rejects(
      () => sendEmail(message({ attachments }), FROM),
      /Invalid value for attachments\[\]\.content/,
    );
  });

  it("rejects attachments that together exceed the total byte cap", async () => {
    const each = Math.ceil(MAX_ATTACHMENTS_TOTAL_BYTES / 3);
    const attachments = ["a", "b", "c"].map((name) => attachment(`${name}.bin`, each));
    await assert.rejects(
      () => sendEmail(message({ attachments }), FROM),
      /at most \d+ bytes across all files/,
    );
  });

  it("rejects more attachments than the count cap", async () => {
    const attachments = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) =>
      attachment(`f${index}.txt`, 1),
    );
    await assert.rejects(() => sendEmail(message({ attachments }), FROM), /at most \d+ files/);
  });

  it("refuses a sender the effective allow-list does not permit", async () => {
    await assert.rejects(() => sendEmail(message(), "evil@attacker.com"), /Invalid value for from/);
  });

  it("rejects a send that was already aborted", async () => {
    await assert.rejects(() => sendEmail(message(), FROM, AbortSignal.abort()));
  });
});

describe("outbox send", () => {
  it("writes a rendered HTML preview under the sender folder", async () => {
    const result = await sendEmail(
      message({ cc: ["team@example.com"], body: "## Status\nResolved." }),
      FROM,
    );
    assert.equal(result.sent, true);
    assert.equal(result.from, FROM);
    assert.equal(result.recipient, "alice@example.com");
    assert.ok(result.messageId?.startsWith(join(OUTBOX_DIR, FROM)));
    const html = await readFile(result.messageId!, "utf8");
    assert.match(html, /Status<\/h2>/);
    assert.match(html, /team@example\.com/);
  });

  it("measures a base64 attachment by its decoded size, not its text length", async () => {
    // Four characters carry three decoded bytes, so the text is longer than
    // what the cap counts.
    const attachments = [
      { filename: "a.bin", content: Buffer.alloc(1024, 7).toString("base64"), encoding: "base64" },
    ];
    const result = await sendEmail(message({ attachments }), FROM);
    assert.equal(result.sent, true);
  });
});
