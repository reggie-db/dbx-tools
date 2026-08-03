/**
 * The email runtime: a lazily-built, process-wide dispatcher plus its
 * resolved config, and {@link sendEmail} which sends one
 * {@link EmailMessage} through it. In SMTP mode the runtime holds a
 * memoized nodemailer transport (shared by the plugin's setup and the
 * agent tool, so they reuse one connection pool); in file/outbox mode it
 * holds no transport and {@link sendEmail} writes HTML to disk instead.
 * The first caller (normally the plugin at setup) primes it with the
 * plugin's config; later callers reuse it.
 *
 * The runtime also carries the {@link EmailExecutor} every outbound send runs
 * through. The plugin installs its own `execute()` there at setup, which is
 * how the Mastra tool - a plain function with no plugin instance in scope -
 * still gets AppKit's retry / timeout / telemetry chain. Without a registered
 * plugin (a direct call from a script or a test) the send still runs, just
 * without interceptors.
 *
 * Every entry point takes an optional {@link AbortSignal} so the plugin's
 * `execute()` timeout and a client disconnect both stop the caller waiting
 * on SMTP.
 *
 * @module
 */

import {
  ConfigurationError,
  ExecutionError,
  ValidationError,
  type ExecutionResult,
} from "@databricks/appkit";
import { execution, log } from "@dbx-tools/shared-core";
import type { EmailAttachment, EmailMessage, EmailResult } from "@dbx-tools/shared-email";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { resolveEmailConfig, type EmailPluginConfig, type ResolvedEmailConfig } from "./config.ts";
import {
  EMAIL_SEND_SETTINGS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_BODY_CHARS,
  type EmailExecutionSettings,
} from "./defaults.ts";
import { renderEmail } from "./email-html.ts";
import { writeOutboxEmail } from "./outbox.ts";
import { assertSenderAllowed } from "./sender.ts";

const logger = log.logger("email/transport");

/**
 * Runs one outbound send through AppKit's interceptor chain. Matches
 * `Plugin.execute()`, which never throws: a failure comes back as
 * `{ ok: false }`.
 */
export type EmailExecutor = <T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  settings: EmailExecutionSettings,
) => Promise<ExecutionResult<T>>;

/** The shared dispatcher, its resolved config, and the send executor. */
export interface EmailRuntime {
  /** Present only in SMTP mode. */
  transporter?: Transporter;
  config: ResolvedEmailConfig;
  execute: EmailExecutor;
}

/**
 * Executor used until (or unless) the plugin installs its own: run the send
 * directly, mapping a throw onto the same {@link ExecutionResult} shape so
 * call sites branch on `ok` either way.
 */
const directExecute = execution.directExecutor<EmailExecutionSettings>();

let runtime: EmailRuntime | undefined;

/**
 * Return the shared runtime, building it on first use by resolving
 * `overrides` over the environment (`SMTP_HOST`, `SMTP_PORT`,
 * `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_DOMAIN`,
 * `EMAIL_FROM`, `EMAIL_ALLOWED_SENDERS`, `EMAIL_SENDER_POLICY`,
 * `EMAIL_OUTBOX_MODE`, `EMAIL_OUTBOX_DIR`) through
 * {@link resolveEmailConfig}. With SMTP credentials present it holds a
 * nodemailer transport and its connection pool; otherwise it is in
 * file/outbox mode and holds none.
 *
 * `overrides` is read only on the call that builds the runtime, so prime it
 * from the plugin's config at setup; later callers (the tool's `execute`,
 * the sender-options route) pass nothing and get the same instance. Throws
 * whatever {@link resolveEmailConfig} throws for an unusable configuration.
 */
export function getEmailRuntime(overrides?: EmailPluginConfig): EmailRuntime {
  if (!runtime) {
    const config = resolveEmailConfig(overrides);
    runtime = {
      config,
      execute: directExecute,
      ...(config.mode === "smtp"
        ? {
            transporter: nodemailer.createTransport({
              host: config.host,
              port: config.port,
              secure: config.secure,
              auth: config.auth,
            }),
          }
        : {}),
    };
  }
  return runtime;
}

/**
 * Install the executor outbound sends run through. The plugin calls this at
 * setup with its own `execute()`; a second call replaces the previous one, so
 * a re-registered plugin does not leave the tools bound to a dead instance.
 */
export function setEmailExecutor(execute: EmailExecutor): void {
  getEmailRuntime().execute = execute;
}

/**
 * Drop the memoized runtime, closing the SMTP connection pool, so the next
 * {@link getEmailRuntime} rebuilds it from fresh config and stops calling
 * through a torn-down plugin's `execute()`. Idempotent, and the plugin's
 * `shutdown()` hook.
 */
export function resetEmailRuntime(): void {
  runtime?.transporter?.close();
  runtime = undefined;
}

/**
 * Run one non-idempotent write through the shared executor and unwrap it.
 *
 * `execute()` never throws, so a failed send arrives as `{ ok: false }` with a
 * status the interceptors already sanitized; it is logged here and re-raised
 * as a stable {@link ExecutionError} so an upstream message never becomes the
 * caller's error text. `signal` is the caller's own cancellation (an agent
 * run, a request teardown); it is merged with the signal the timeout
 * interceptor supplies so either one unwinds the I/O.
 */
export async function executeWrite<T>(
  operation: string,
  settings: EmailExecutionSettings,
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { execute } = getEmailRuntime();
  return execution.run({
    operation,
    settings,
    execute,
    fn,
    signal,
    canceled: ExecutionError.canceled,
    failed: (failure) => {
      logger.warn("execution-failed", {
        operation: failure.operation,
        status: failure.status,
        error: failure.message,
      });
      return new ExecutionError(`email: ${failure.operation} failed`, {
        context: { operation: failure.operation, status: failure.status },
      });
    },
  });
}

/**
 * Open and tear down one SMTP connection to prove the host, port, and
 * credentials work. Called at plugin setup so a bad relay shows up in the
 * boot logs rather than on the first approved send.
 */
export async function verifyEmailTransport(
  transporter: Transporter | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!transporter) {
    throw ConfigurationError.invalidConnection(
      "SMTP",
      "The runtime resolved to outbox mode, so there is no transport to verify.",
    );
  }
  await abortable(transporter.verify(), signal);
}

/**
 * Stop awaiting `promise` as soon as `signal` aborts. nodemailer exposes no
 * cancellation hook, so the SMTP conversation itself finishes on its own
 * connection; what unwinds is the caller and everything downstream of it.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  // The listener is detached once the race settles so a long-lived run signal
  // does not accumulate one per send.
  const listener = new AbortController();
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
      signal: listener.signal,
    });
  });
  return Promise.race([promise, aborted]).finally(() => listener.abort());
}

/** The comma-joined recipient string echoed back in {@link EmailResult}. */
function recipientEcho(to: string[]): string {
  return to.join(", ");
}

/**
 * Node buffer encodings a wire attachment may name for its inline `content`.
 * Anything else is measured as UTF-8, which over-counts rather than letting
 * an unrecognized encoding slip past the size cap.
 */
const CONTENT_ENCODINGS: ReadonlySet<string> = new Set([
  "ascii",
  "base64",
  "base64url",
  "binary",
  "hex",
  "latin1",
  "ucs2",
  "ucs-2",
  "utf8",
  "utf-8",
  "utf16le",
  "utf-16le",
]);

/**
 * Decoded byte size of one attachment's inline content. A `path` attachment
 * contributes nothing: nodemailer streams it, so its bytes never sit in this
 * process and cannot be measured here.
 */
function attachmentBytes(attachment: EmailAttachment): number {
  const { content, encoding } = attachment;
  if (content === undefined) return 0;
  const declared = encoding?.toLowerCase();
  const resolved =
    declared && CONTENT_ENCODINGS.has(declared) ? (declared as BufferEncoding) : "utf8";
  return Buffer.byteLength(content, resolved);
}

/**
 * Reject a message whose body or attachments exceed the plugin's caps. The
 * body and attachment list arrive from a model, so they are unbounded until
 * something bounds them; most SMTP relays also reject an oversized message
 * only after the whole payload has been uploaded.
 */
function assertMessageWithinCaps(message: EmailMessage): void {
  if (message.body.length > MAX_BODY_CHARS) {
    throw ValidationError.invalidValue(
      "body",
      message.body.length,
      `at most ${MAX_BODY_CHARS} characters`,
    );
  }
  const attachments = message.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw ValidationError.invalidValue(
      "attachments",
      attachments.length,
      `at most ${MAX_ATTACHMENT_COUNT} files`,
    );
  }
  let total = 0;
  for (const attachment of attachments) {
    const bytes = attachmentBytes(attachment);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw ValidationError.invalidValue(
        "attachments[].content",
        bytes,
        `at most ${MAX_ATTACHMENT_BYTES} bytes per file`,
      );
    }
    total += bytes;
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw ValidationError.invalidValue(
      "attachments",
      total,
      `at most ${MAX_ATTACHMENTS_TOTAL_BYTES} bytes across all files`,
    );
  }
}

/**
 * Map the wire-format {@link EmailAttachment}s onto nodemailer's
 * attachment shape, dropping unset optional keys so nodemailer applies
 * its own defaults (utf-8 encoding, filename-inferred content type). The
 * wire fields are a deliberate subset of nodemailer's, so this is a
 * straight structural pass-through.
 */
function toMailAttachments(
  attachments: EmailAttachment[] | undefined,
): SendMailOptions["attachments"] {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att) => ({
    filename: att.filename,
    ...(att.content !== undefined ? { content: att.content } : {}),
    ...(att.encoding !== undefined ? { encoding: att.encoding } : {}),
    ...(att.path !== undefined ? { path: att.path } : {}),
    ...(att.contentType !== undefined ? { contentType: att.contentType } : {}),
  }));
}

/**
 * Hand one already-validated message to SMTP, or write it to the outbox when
 * no credentials are configured. The half of a send that performs I/O, so it
 * is what runs inside the interceptor chain.
 */
async function dispatch(
  message: EmailMessage,
  from: string,
  signal?: AbortSignal,
  options?: SendEmailOptions,
): Promise<EmailResult> {
  const { config, transporter } = getEmailRuntime();
  const recipient = recipientEcho(message.to);
  signal?.throwIfAborted();

  if (config.mode === "file") {
    const path = await writeOutboxEmail(message, from, config.outDir, config.brand, {
      ...(options?.heading !== undefined ? { heading: options.heading } : {}),
      ...(options?.preview !== undefined ? { preview: options.preview } : {}),
    });
    return { sent: true, recipient, from, messageId: path };
  }

  if (!transporter) {
    throw ConfigurationError.invalidConnection(
      "SMTP",
      "No transport was built for the resolved configuration.",
    );
  }
  const attachments = toMailAttachments(message.attachments);
  const rendered = await renderEmail({
    subject: message.subject,
    body: message.body,
    brand: config.brand,
    ...(options?.heading !== undefined ? { heading: options.heading } : {}),
    ...(options?.preview !== undefined ? { preview: options.preview } : {}),
  });
  const info = await abortable(
    transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      // A caller-supplied plain-text part WINS over the generated one. Both parts
      // still come from the same content; this only lets a caller control the
      // text alternative's exact line layout, which some clients parse (see
      // `SendEmailOptions.text`).
      text: options?.text ?? rendered.text,
      html: rendered.html,
      ...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
      ...(message.bcc && message.bcc.length > 0 ? { bcc: message.bcc } : {}),
      ...(attachments ? { attachments } : {}),
    }),
    signal,
  );
  return {
    sent: true,
    recipient,
    from,
    ...(info.messageId ? { messageId: info.messageId } : {}),
  };
}

/**
 * Delivery-time options that are NOT part of the message a model composes.
 *
 * Deliberately separate from {@link EmailMessage}: that schema is the agent
 * tool's input, so anything added to it becomes a field a model can set. These
 * describe how a message is DELIVERED, so they are the caller's to supply.
 */
export interface SendEmailOptions {
  /**
   * Visible heading inside the branded HTML card. Defaults to the message
   * subject. Use this when the transport subject carries notification-specific
   * details that would be noisy if repeated inside the opened email.
   */
  heading?: string;
  /**
   * An explicit `text/plain` alternative, replacing the one generated from the
   * React Email tree. The HTML part is untouched, so the recipient still gets the
   * full branded template.
   *
   * This exists because the generated text part is a RENDERING of the HTML: it
   * carries the brand header and footer, and it turns CSS margin into blank
   * lines. That is fine for prose and wrong for content a machine parses. A
   * one-time-code email is the case in point - clients look for the code on the
   * line immediately after the prompt, and a styled `<h2>` code lands two blank
   * lines below it, so autofill stops being offered even though the HTML looks
   * perfect. Supplying the text part directly keeps the nice template AND the
   * layout those clients expect.
   *
   * Keep the same information in both parts; a text alternative that disagrees
   * with the HTML reads as phishing to spam filters.
   */
  text?: string;
  /**
   * Preheader text for the HTML part - the snippet shown beside the subject in an
   * inbox list, and the body of the PUSH NOTIFICATION a mobile mail app posts.
   * Defaults to the subject.
   *
   * Delivery-time rather than part of {@link EmailMessage} for the same reason as
   * `text`: it is presentation the sending CODE chooses, not content a model
   * composes. The one-time-code path sets it so the code itself rides in the
   * notification, which is the only text iOS autofill gets to read.
   */
  preview?: string;
}

/**
 * Send (SMTP mode) or persist (file/outbox mode) one message from the
 * resolved `from` address. `to` (and optional `cc` / `bcc`) each accept
 * one or more addresses, and `attachments` are forwarded as files. The
 * body is rendered by React Email into matching plain-text and HTML MIME
 * alternatives, and the outbox embeds the
 * rendered HTML in a document. In file mode the returned `messageId` is
 * the path written. Throws when `to` carries no recipient, when the body
 * or attachments exceed the plugin's caps, or when `from` is not permitted
 * by the effective sender allow-list.
 *
 * The recipient, cap, and sender checks run before the interceptor chain so
 * their specific status and actionable message reach the caller instead of
 * the chain's stable failure text. `signal` cancels the send.
 */
export async function sendEmail(
  message: EmailMessage,
  from: string,
  signal?: AbortSignal,
  options?: SendEmailOptions,
): Promise<EmailResult> {
  if (message.to.length === 0) {
    throw ValidationError.missingField("to");
  }
  assertMessageWithinCaps(message);
  assertSenderAllowed(from, getEmailRuntime().config.allowedSenders);
  return executeWrite(
    "send",
    EMAIL_SEND_SETTINGS,
    (executeSignal) => dispatch(message, from, executeSignal, options),
    signal,
  );
}
