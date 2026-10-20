/** Node rendering helper backed by the shared React Email body. @module */
import { EmailBody, normalizeEmailMarkdown } from "@dbx-tools/shared-email-template";
import { render } from "@react-email/render";
import { createElement } from "react";

/** Render a standalone message body through React Email. */
export async function markdownToHtml(body: string): Promise<string> {
  return render(createElement(EmailBody, { body: normalizeEmailMarkdown(body) }), {
    pretty: true,
  });
}
