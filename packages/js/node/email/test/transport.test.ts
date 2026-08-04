import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  emailMessageSchema,
  type EmailAttachment,
  type EmailMessage,
} from "@dbx-tools/shared-email";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_BODY_CHARS,
} from "../src/defaults.ts";
import {
  getEmailRuntime,
  resetEmailRuntime,
  sendEmail,
  type SendEmailOptions,
} from "../src/transport.ts";

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
  it("rejects model-controlled attachment paths and URLs", () => {
    assert.throws(() =>
      emailMessageSchema.parse(
        message({
          attachments: [{ filename: "secrets.txt", path: "/etc/passwd" } as EmailAttachment],
        }),
      ),
    );
  });

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
    assert.match(html, /Status\s*<\/h2>/);
    assert.match(html, /team@example\.com/);
  });

  it("uses caller-supplied heading and preheader presentation", async () => {
    const result = await sendEmail(message(), FROM, undefined, {
      heading: "Verification code",
      preview: "Your verification code is: 123456",
    });
    const html = await readFile(result.messageId!, "utf8");
    assert.match(html, /Verification code\s*<\/h1>/);
    assert.match(html, /Your verification code is: 123456/);
    assert.doesNotMatch(html, />Subject\s*<\/h1>/);
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

/**
 * The `text` option is what lets a one-time-code email keep the branded HTML
 * template AND the machine-parseable plain-text layout. Asserted against the
 * payload handed to nodemailer, since "which string lands in `text`" is the whole
 * contract - the generated fallback is a rendering of the HTML and cannot hold
 * that layout.
 */
describe("caller-supplied plain-text alternative", () => {
  /** Send through a stubbed SMTP transporter and return the captured payload. */
  async function captureSend(options?: SendEmailOptions): Promise<{ text: string; html: string }> {
    const saved = { ...process.env };
    delete process.env.EMAIL_OUTBOX_MODE;
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASSWORD = "secret";
    process.env.EMAIL_FROM = FROM;
    resetEmailRuntime();
    try {
      const runtime = getEmailRuntime();
      assert.equal(runtime.config.mode, "smtp");
      let captured: { text: string; html: string } | undefined;
      // The transporter is the seam: everything above it is the code under test.
      (runtime.transporter as unknown as Record<string, unknown>).sendMail = async (payload: {
        text: string;
        html: string;
      }) => {
        captured = payload;
        return { messageId: "stub" };
      };
      await sendEmail(
        message({ body: "Your verification code is:\n\n## 123456\n\nExpires in 10 minutes." }),
        FROM,
        undefined,
        options,
      );
      assert.ok(captured, "sendMail was not reached");
      return captured;
    } finally {
      Object.assign(process.env, saved);
      resetEmailRuntime();
    }
  }

  it("sends the supplied text verbatim while keeping the branded HTML", async () => {
    const supplied = "Your verification code is: 123456\nExpires in 10 minutes.";
    const { text, html } = await captureSend({ text: supplied });
    assert.equal(text, supplied, "the caller owns the text part exactly");
    // The prompt and the code on ONE line is the functional part: that is what
    // client code detection keys on.
    assert.match(text, /^Your verification code is: 123456$/m);
    // ...and the recipient still gets the full template, code styled as a heading.
    assert.match(html, /<h2[^>]*>\s*123456/);
  });

  it("renders the caller-supplied heading and preheader", async () => {
    const { html } = await captureSend({
      heading: "Verification code",
      preview: "Your verification code is: 123456",
    });
    assert.match(html, /Verification code\s*<\/h1>/);
    assert.match(html, /Your verification code is: 123456/);
    assert.doesNotMatch(html, />Subject\s*<\/h1>/);
  });

  it("falls back to the generated text part when none is supplied", async () => {
    const { text } = await captureSend();
    assert.match(text, /123456/);
    // The generated part is a rendering of the HTML, so the heading's margin
    // shows up as blank lines - which is precisely why the option exists.
    assert.match(text, /code is:\n\n\n123456/);
  });
});
