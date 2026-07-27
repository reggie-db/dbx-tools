/**
 * The `send_email` Mastra tool: approval-gated so a model can draft a
 * message freely but nothing leaves the building until a human clicks
 * Approve in the chat UI. On approval the sender is resolved (explicit
 * `from` config, else derived from the on-behalf-of user's email) and
 * the message is dispatched through the shared SMTP transport.
 *
 * The sender derivation runs inside the AppKit user scope, so
 * `getExecutionContext()` returns the OBO user whose local-part seeds
 * the address (see {@link deriveSenderAddress}).
 *
 * The dispatch itself goes through the executor the plugin installs on the
 * shared runtime, so a send from this tool picks up the same retry / timeout /
 * telemetry chain as one from the AppKit tool. In a Mastra app with no AppKit
 * plugin registered the send still runs, just without interceptors.
 *
 * @module
 */

import { getExecutionContext } from "@databricks/appkit";
import { log, string } from "@dbx-tools/shared-core";
import { email } from "@dbx-tools/shared-email";
import { createTool } from "@mastra/core/tools";
import { resolveSenderAddress } from "./sender";
import { getEmailRuntime, sendEmail } from "./transport";

const logger = log.logger("email/tool/send-email");

/**
 * The model-facing description of the send capability, shared by the Mastra
 * {@link emailTool} and the AppKit `email.send` tool so both agents get the
 * same guidance about approval, scope, and body formatting.
 */
export const SEND_EMAIL_DESCRIPTION = string.toDescription(`
  Send an email on the user's behalf. Pass one or more recipient
  addresses (with optional cc / bcc and file attachments), a subject,
  and a body; the user is prompted to approve the send before it goes
  out (this tool is approval-gated). Use it only when the user
  explicitly asks to send / forward / share something via email -
  never autonomously. Keep subjects short and bodies self-contained:
  the recipient has none of the chat context. Write the body in
  GitHub-Flavored Markdown - headings, lists, and real Markdown
  tables - not ASCII art (no "=====" dividers or space/pipe-drawn
  tables); it is rendered to HTML before sending.
`);

/** Options accepted by {@link emailTool}. */
export interface EmailToolOptions {
  /**
   * Override the tool id. Defaults to `"send_email"`; the chat UI's
   * approval gate keys off this id, so keep it unless you also teach
   * the client about the new name.
   */
  id?: string;
}

/**
 * Build the approval-gated `send_email` tool. Spread it into the agents
 * that should be able to draft mail; it is intentionally not installed
 * everywhere.
 *
 * @example
 * ```ts
 * import { emailTool } from "@dbx-tools/email";
 * import { createAgent } from "@dbx-tools/appkit-mastra";
 *
 * const support = createAgent({
 *   instructions: "...",
 *   tools: () => ({ send_email: emailTool() }),
 * });
 * ```
 */
export function emailTool(opts: EmailToolOptions = {}) {
  return createTool({
    id: opts.id ?? "send_email",
    description: SEND_EMAIL_DESCRIPTION,
    inputSchema: email.emailMessageSchema,
    outputSchema: email.emailResultSchema,
    requireApproval: true,
    execute: async (input, context) => {
      const message = email.emailMessageSchema.parse(input);
      const { config } = getEmailRuntime();
      const ctx = getExecutionContext();
      const userEmail = "isUserContext" in ctx ? ctx.userEmail : undefined;
      const from = resolveSenderAddress(config, userEmail);
      const result = await sendEmail(message, from, context?.abortSignal);
      logger.info("sent", {
        to: result.recipient,
        from: result.from,
        ...(result.messageId ? { messageId: result.messageId } : {}),
      });
      return result;
    },
  });
}
