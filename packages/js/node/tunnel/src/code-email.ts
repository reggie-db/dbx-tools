/**
 * Pure builders for the OTP code email's copy - subject, preheader, and the HTML
 * and text bodies. No transport, no `@dbx-tools/email` import, so this module is
 * safe to load whether or not the optional email dependency is present; the actual
 * send lives in `./send-code`.
 *
 * The shapes here are load-bearing for mobile autofill: the code rides in the
 * SUBJECT and the PREHEADER (the whole of a push notification), and the text part
 * keeps the prompt and code on ONE line. See each function for why.
 *
 * @module
 */

import { string } from "@dbx-tools/shared-core";
import type { SendCodeOptions } from "./plugin.ts";

/** The parts of {@link SendCodeOptions} the code email's copy is built from. */
export type CodeCopy = Pick<SendCodeOptions, "message" | "codeTtlSeconds">;

/** The reassurance line closing both parts. */
const IGNORE_LINE = "If you did not request this code, you can ignore this email.";

/**
 * A code TTL as the plain phrase the email states ("10 minutes", "45 seconds").
 *
 * Whole minutes read as minutes; anything else stays in seconds rather than
 * rounding, so a 90-second TTL is not advertised as "1 minute" and a recipient is
 * never told the code lives longer than it does.
 */
export function expiresIn(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0
    ? string.pluralize(seconds / 60, "minute")
    : string.pluralize(seconds, "second");
}

/**
 * The HTML part's source: the full branded template, with the code as a large
 * styled heading (`## ` is what makes it prominent in an inbox).
 */
export function codeEmailHtmlBody(code: string, opts: CodeCopy): string {
  return [
    opts.message,
    "",
    `## ${code}`,
    "",
    `This code expires in ${expiresIn(opts.codeTtlSeconds)}.`,
    "",
    IGNORE_LINE,
  ].join("\n");
}

/**
 * The `text/plain` part, supplied EXPLICITLY rather than rendered from the tree
 * above. Both parts say the same thing; only the line layout differs.
 *
 * The prompt and the code share ONE line ("Your verification code is: 123456").
 * That single-line shape is what iOS, Gmail, Outlook, and Android code detection
 * keys on most reliably - the heuristics look for a code in the same sentence as
 * a recognized prompt, so splitting them across lines makes detection dependent
 * on the client, and any blank line between them defeats it outright.
 *
 * The GENERATED text part cannot hold that shape at all: it is a rendering of the
 * HTML, so it carries the brand header/footer and turns the code heading's CSS
 * margin into blank lines, arriving as `prompt\n\n\ncode`.
 *
 * The code is visible text in BOTH parts, never an image, so a client scraping
 * either one finds it. No trailer line follows the copy - Apple's domain-bound
 * `@domain #code` footer is deliberately NOT emitted, since it constrains the
 * code to one origin and is not what the broadly-compatible shape needs.
 */
export function codeEmailTextBody(code: string, opts: CodeCopy): string {
  return [
    `${opts.message} ${code}`,
    `This code expires in ${expiresIn(opts.codeTtlSeconds)}.`,
    "",
    IGNORE_LINE,
  ].join("\n");
}

/**
 * The SUBJECT line, with the code in it: `"123456 is your verification code"`.
 *
 * The code has to be here, not only in the body, because of what mobile autofill
 * actually reads. iOS offers a code from an incoming NOTIFICATION - natively for
 * Messages and Mail, and since iOS 26 for any app's notification text, which is
 * what finally made Gmail work - and a notification contains the sender, the
 * subject, and a short snippet. Nothing else. A code that lives in the body is
 * invisible to it, however cleanly the body is formatted, which is why a perfectly
 * shaped `text/plain` part still produced no autofill prompt in Gmail.
 *
 * `<code> is your <thing>` rather than `<thing>: <code>` because the leading code
 * survives TRUNCATION: a notification and an inbox list both cut the subject, and
 * the platform heuristics want the code in the same sentence as a recognized
 * prompt ("code", "verification"). Putting it first keeps both intact no matter
 * where the cut lands.
 *
 * `subject` is the configured line ("Your verification code"), lower-cased at its
 * first word so the sentence reads naturally, and left ALONE when it does not look
 * like the conventional phrasing - an operator who set a deliberate subject gets
 * theirs with the code prefixed, not a mangled hybrid.
 */
export function codeEmailSubject(code: string, subject: string): string {
  const trimmed = subject.trim();
  const conventional = /^your\s+/i.exec(trimmed);
  const rest = conventional ? trimmed.slice(conventional[0].length) : trimmed;
  return conventional ? `${code} is your ${rest}` : `${code} - ${trimmed}`;
}

/**
 * The PREHEADER: the snippet beside the subject in an inbox list, and the body of
 * the push notification. Carries the code for the same reason the subject does -
 * it is the other half of what a notification shows - and repeats the prompt
 * wording so a heuristic scanning the snippet alone finds a code next to a phrase
 * it recognizes.
 */
export function codeEmailPreview(code: string, opts: CodeCopy): string {
  return `${opts.message} ${code}`;
}
