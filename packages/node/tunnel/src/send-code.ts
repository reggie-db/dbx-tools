/**
 * The default `sendCode` for the {@link AuthGatePlugin}: deliver the OTP through
 * the host app's ALREADY-PRIMED `@dbx-tools/email` transport, as the system
 * sender (a verification code is machine-generated and unanswerable, so it must
 * not arrive from a person's address inviting a reply).
 *
 * `@dbx-tools/email` is an OPTIONAL dependency of the tunnel - a tunnel used
 * without the gate needs no mail. So it is imported LAZILY here; a missing module
 * surfaces only when a gate actually tries to send a code, and
 * {@link ensureEmailAvailable} turns that into a clear fail-fast at boot.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import {
  codeEmailHtmlBody,
  codeEmailPreview,
  codeEmailSubject,
  codeEmailTextBody,
} from "./code-email.ts";
import type { AuthGateConfig, SendCodeOptions } from "./plugin.ts";

const logger = log.logger("tunnel:send-code");

/** The slice of `@dbx-tools/email` the gate uses, resolved lazily. */
interface EmailModule {
  sender: { resolveSystemSenderAddress: (config: unknown) => string };
  transport: {
    getEmailRuntime: () => { config: { mode: string } };
    sendEmail: (
      message: { to: string[]; subject: string; body: string },
      from: string,
      onBehalfOf: undefined,
      extra: { heading: string; text: string; preview: string },
    ) => Promise<void>;
  };
}

let cached: EmailModule | undefined;

/**
 * Import `@dbx-tools/email` lazily. Throws a clear, actionable error when the
 * optional dependency is absent - the caller (a gate that is NOT insecure) treats
 * that as fatal, since a gate that cannot email a code lets nobody in.
 */
async function loadEmail(): Promise<EmailModule> {
  if (cached) return cached;
  try {
    const mod = (await import("@dbx-tools/email")) as unknown as EmailModule;
    cached = mod;
    return mod;
  } catch (cause) {
    throw new Error(
      "the OTP gate needs @dbx-tools/email to send codes, but it is not installed. " +
        "Add @dbx-tools/email to the app, or run the tunnel with --insecure / TUNNEL_INSECURE=true.",
      { cause },
    );
  }
}

/**
 * Fail fast when the gate cannot deliver codes: the optional email module must be
 * importable AND configured for SMTP (real delivery). `mode: "file"` (outbox) or a
 * throwing runtime means no code reaches a real inbox, so a gate on that config
 * would silently admit nobody. Called from the plugin's `setup:complete` unless
 * insecure.
 */
export async function ensureEmailAvailable(): Promise<void> {
  const { transport } = await loadEmail();
  if (transport.getEmailRuntime().config.mode !== "smtp") {
    throw new Error(
      "email is not configured for SMTP delivery - the OTP gate cannot send codes. " +
        "Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD, or pass --insecure / TUNNEL_INSECURE=true.",
    );
  }
}

/**
 * The default code sender: render the OTP email (code in the subject + preheader
 * for mobile autofill; see `codeEmailSubject`) and send it through the shared
 * transport as the system sender.
 */
export const sendCode: NonNullable<AuthGateConfig["sendCode"]> = async (
  to: string,
  code: string,
  opts: SendCodeOptions,
): Promise<void> => {
  const { sender, transport } = await loadEmail();
  const from = sender.resolveSystemSenderAddress(transport.getEmailRuntime().config);
  await sendEmailWith(transport, to, code, opts, from);
};

function sendEmailWith(
  transport: EmailModule["transport"],
  to: string,
  code: string,
  opts: SendCodeOptions,
  from: string,
): Promise<void> {
  logger.debug("sending code email", { to });
  return transport.sendEmail(
    {
      to: [to],
      subject: codeEmailSubject(code, opts.subject),
      body: codeEmailHtmlBody(code, opts),
    },
    from,
    undefined,
    {
      heading: opts.subject,
      text: codeEmailTextBody(code, opts),
      preview: codeEmailPreview(code, opts),
    },
  );
}
