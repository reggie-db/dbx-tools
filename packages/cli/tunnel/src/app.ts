/**
 * The tunnel gate's tiny AppKit "app" - `createApp` WITHOUT a `server()` plugin.
 *
 * There is no HTTP server here: the tunnel proxy is the server, and it calls the
 * gate handlers in-process. `createApp` is used only for what it auto-wires:
 *   - `CacheManager` (memory, or Lakebase when the deploy configures persistent
 *     cache storage) - which the OTP `CodeStore` uses for storage + TTL eviction;
 *   - the `email()` transport (SMTP / outbox), primed from env, so `sendCode` can
 *     deliver the one-time code;
 *   - dbx-tools auto-configuration + branding via `@dbx-tools/appkit`.
 *
 * It returns the {@link AuthGateApi} the proxy drives. `sendCode` is wired here
 * (the plugin can't resolve HOW to send on its own) to the email plugin's
 * transport. A sign-in code is SYSTEM mail - no on-behalf-of user asked for it
 * and no reply to it reaches anyone - so it sends from the email config's
 * do-not-reply address (`no-reply@EMAIL_DOMAIN` unless EMAIL_SYSTEM_FROM names
 * another).
 *
 * FAIL FAST: a gate that can't email a code is useless, so if email does not
 * resolve to SMTP mode (real delivery), this throws - unless `insecure` is set
 * (`--insecure` / `TUNNEL_INSECURE=true`), in which case the caller runs the
 * tunnel OPEN with no gate.
 *
 * @module
 */

import { createApp as createAppNs } from "@dbx-tools/appkit";
import { brand as nodeBrand } from "@dbx-tools/core";
import { brand as emailBrand, email, sender, transport } from "@dbx-tools/email";
import { log, string } from "@dbx-tools/shared-core";
import { authGate, type AuthGateApi, type AuthGateConfig, type SendCodeOptions } from "./plugin.ts";

const logger = log.logger("tunnel:app");

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

/** The parts of {@link SendCodeOptions} the code email's copy is built from. */
type CodeCopy = Pick<SendCodeOptions, "message" | "codeTtlSeconds">;

/** The reassurance line closing both parts. */
const IGNORE_LINE = "If you did not request this code, you can ignore this email.";

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

const { createApp } = createAppNs;
const { resolveSystemSenderAddress } = sender;
const { getEmailRuntime, sendEmail } = transport;
const { emailBrandFromContext } = emailBrand;
const { loadBrandContext } = nodeBrand;

/**
 * Boot the gate app and return the API the proxy calls. Throws when email is not
 * in SMTP mode (no way to deliver a code) so a misconfigured gate fails fast at
 * startup rather than silently accepting nobody; the caller may catch this and
 * fall back to insecure/open mode when the operator opted in.
 */
export async function startGateApp(config: AuthGateConfig): Promise<AuthGateApi> {
  // The host app's own brand (`branding/brand.yaml` discovered from cwd) or the
  // dbx-tools default. This is the ONE brand source for the gate: it styles the
  // code email (accent band, font, logo) via the email plugin AND supplies the
  // display name the copy uses, so a deployment that themes its app themes its
  // sign-in email with it. An explicit `brandName` still wins (see below).
  const context = await loadBrandContext();

  // `sendCode` delivers the OTP through the email plugin's SHARED transport, which
  // the `email()` plugin primes during its `setup()` (awaited by `createApp`
  // below). Using the module-level `sendEmail` avoids a circular dependency on the
  // app handle's inferred type. The `From` is the SYSTEM sender: a verification
  // code is machine-generated and unanswerable, so it must not arrive from a
  // person's address inviting a reply.
  const sendCode: NonNullable<AuthGateConfig["sendCode"]> = async (to, code, opts) => {
    const from = resolveSystemSenderAddress(getEmailRuntime().config);
    await sendEmail(
      {
        to: [to],
        subject: opts.subject,
        body: codeEmailHtmlBody(code, opts),
      },
      from,
      undefined,
      { text: codeEmailTextBody(code, opts) },
    );
  };

  // `createApp` namespaces each plugin's exports on the handle by manifest name;
  // `handle.authGate` is the in-process gate API the proxy drives.
  const handle = await createApp({
    plugins: [
      // Brand the code email from the resolved context, the same bridge every
      // other dbx-tools email surface uses (accent + font inlined, logo only when
      // it is a fetchable URL - a package-export path cannot load in an inbox).
      email({ brand: emailBrandFromContext(context) }),
      // `brandName` falls back to the resolved context's display name, so the
      // email copy names the app rather than a generic placeholder. Spelled as an
      // explicit `??` rather than a key before `...config`: commander sets
      // `brandName` on the options object whether or not the flag was passed, so
      // spreading it would clobber the context name with `undefined`.
      authGate({ ...config, brandName: config.brandName ?? context.name, sendCode }),
    ],
  });

  // Fail fast: the gate needs SMTP to email codes. `getEmailRuntime()` resolves to
  // `mode: "file"` (outbox) or throws when no SMTP creds are configured - neither
  // can deliver to a real inbox, so refuse to bring up a gate that lets nobody in.
  if (getEmailRuntime().config.mode !== "smtp") {
    throw new Error(
      "email is not configured for SMTP delivery - the OTP gate cannot send codes. " +
        "Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD, or pass --insecure / TUNNEL_INSECURE=true to run the tunnel open.",
    );
  }

  logger.info("gate app ready (no server; proxy-driven)");
  return handle.authGate as AuthGateApi;
}
