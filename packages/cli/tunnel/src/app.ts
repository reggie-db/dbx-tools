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
 * transport, resolving the `From` from the email runtime config (EMAIL_FROM /
 * EMAIL_DOMAIN) since an OTP request has no on-behalf-of user.
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
import { log, object, string } from "@dbx-tools/shared-core";
import { autofillTrailer } from "@dbx-tools/shared-email-template";
import { authGate, type AuthGateApi, type AuthGateConfig } from "./plugin.ts";

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

const { createApp } = createAppNs;
const { resolveSenderAddress } = sender;
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
  // app handle's inferred type. `From` is the app's configured sender (EMAIL_FROM /
  // EMAIL_DOMAIN); the code email has no OBO user, so it resolves with `undefined`.
  const sendCode: NonNullable<AuthGateConfig["sendCode"]> = async (to, code, opts) => {
    const from = resolveSenderAddress(getEmailRuntime().config, undefined);
    await sendEmail(
      {
        to: [to],
        subject: opts.subject,
        // Deliberately the conventional one-time-code layout: the prompt line,
        // then the bare code ALONE on the next line, then the expiry. iOS, Gmail,
        // Outlook, and Android all detect a code from this shape and offer to
        // autofill it, and anything more decorative is what breaks that. The code
        // stays visible TEXT in both MIME parts (the email plugin renders the
        // HTML and plain-text alternatives from one React Email tree), never an
        // image, so a client that scrapes the text part still finds it. The
        // `trailer` below adds Apple's domain-bound AutoFill on top.
        body: [
          opts.message,
          "",
          `## ${code}`,
          "",
          `This code expires in ${expiresIn(opts.codeTtlSeconds)}.`,
          "",
          "If you did not request this code, you can ignore this email.",
        ].join("\n"),
      },
      from,
      undefined,
      // Apple's domain-bound AutoFill, layered ON TOP of the conventional layout
      // above (which is what iOS/Gmail/Outlook/Android already detect
      // heuristically). Passed as a delivery OPTION rather than appended to the
      // body because iOS only honours `@<domain> #<code>` as the message's final
      // line, and the branded footer renders after the body. Omitted when no
      // public domain is configured - there is no host to bind the code to.
      object.optional("trailer", autofillTrailer(opts.publicDomain, code)),
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
