/** Node rendering adapters for the shared React Email document. @module */
import { string } from "@dbx-tools/shared-core";
import { EmailDocument, type EmailDocumentProps } from "@dbx-tools/shared-email-template";
import { render } from "@react-email/render";
import { createElement } from "react";

/** Escape HTML-significant characters (re-exported from shared-core). */
export const escapeHtml = string.escapeHtml;

/** Options accepted by the shared React Email document. */
export type EmailHtmlOptions = EmailDocumentProps;

/** Render a complete responsive React Email document. */
export async function renderEmailHtml(options: EmailHtmlOptions): Promise<string> {
  return render(createElement(EmailDocument, options), { pretty: true });
}

/** Render the same React Email document as its plain-text alternative. */
export async function renderEmailText(options: EmailHtmlOptions): Promise<string> {
  return render(createElement(EmailDocument, options), { plainText: true });
}

/** Render both MIME alternatives from one shared React Email component tree. */
export async function renderEmail(
  options: EmailHtmlOptions,
): Promise<{ html: string; text: string }> {
  const element = createElement(EmailDocument, options);
  const [html, text] = await Promise.all([
    render(element, { pretty: true }),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}
