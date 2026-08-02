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
import { email, sender, transport } from "@dbx-tools/email";
import { log } from "@dbx-tools/shared-core";
import { authGate, type AuthGateApi, type AuthGateConfig } from "./plugin.ts";

const logger = log.logger("tunnel:app");

const { createApp } = createAppNs;
const { resolveSenderAddress } = sender;
const { getEmailRuntime, sendEmail } = transport;

/**
 * Boot the gate app and return the API the proxy calls. Throws when email is not
 * in SMTP mode (no way to deliver a code) so a misconfigured gate fails fast at
 * startup rather than silently accepting nobody; the caller may catch this and
 * fall back to insecure/open mode when the operator opted in.
 */
export async function startGateApp(config: AuthGateConfig): Promise<AuthGateApi> {
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
        body: [
          opts.message,
          "",
          `## ${code}`,
          "",
          "It expires shortly. If you didn't request this, ignore this email.",
        ].join("\n"),
      },
      from,
    );
  };

  // `createApp` namespaces each plugin's exports on the handle by manifest name;
  // `handle.authGate` is the in-process gate API the proxy drives.
  const handle = await createApp({ plugins: [email(), authGate({ ...config, sendCode })] });

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
