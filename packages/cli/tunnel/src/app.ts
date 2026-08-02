/**
 * The tunnel gate's tiny AppKit "app" - `createApp` WITHOUT a `server()` plugin.
 *
 * There is no HTTP server here: the tunnel proxy is the server, and it calls the
 * gate handlers in-process. `createApp` is used only for what it auto-wires:
 *   - `CacheManager` (Lakebase when this process can reach it, else memory) -
 *     which the OTP `CodeStore` and the session signing key use for storage + TTL
 *     eviction;
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

import { getUsernameWithApiLookup } from "@databricks/appkit";
import { createApp as createAppNs, lakebaseResolver } from "@dbx-tools/appkit";
import { brand as nodeBrand } from "@dbx-tools/core";
import { brand as emailBrand, email, sender, transport } from "@dbx-tools/email";
import { env, log, string } from "@dbx-tools/shared-core";
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

const { createApp } = createAppNs;
const { applyLakebaseToEnv, resolveLakebaseConnection } = lakebaseResolver;
const { resolveSystemSenderAddress } = sender;
const { getEmailRuntime, sendEmail } = transport;
const { emailBrandFromContext } = emailBrand;
const { loadBrandContext } = nodeBrand;

/**
 * Env vars whose presence means a Lakebase database was bound to this deployment.
 * `LAKEBASE_ENDPOINT` is what a Databricks App `postgres` resource binding sets;
 * `PGHOST` is the local/manual spelling.
 */
const LAKEBASE_ENV = ["LAKEBASE_ENDPOINT", "PGHOST"] as const;

/**
 * Upper bound on resolving the Lakebase connection. The gate is in the request
 * path for every visitor, so a slow workspace API must not hold up boot
 * indefinitely; a memory cache is a degraded gate, an unbooted one is no gate.
 */
const LAKEBASE_RESOLVE_TIMEOUT_MS = 60_000;

/**
 * Fill in the Lakebase connection env AppKit's cache needs, so `CacheManager`
 * chooses PERSISTENT storage instead of memory.
 *
 * This is what makes the gate's session signing key and outstanding one-time
 * codes survive a restart, and it has to be done explicitly here. AppKit picks
 * Lakebase for the cache only when `createLakebasePool()` succeeds, and that pool
 * reads FOUR things off `process.env`: `LAKEBASE_ENDPOINT`, `PGHOST`,
 * `PGDATABASE`, and a username (`PGUSER`, or `DATABRICKS_CLIENT_ID` for a service
 * principal). A Databricks App `postgres` resource binding supplies only
 * `LAKEBASE_ENDPOINT`. The resolver turns that one value into the host and
 * database; the username is looked up separately, because missing it fails pool
 * construction just as hard as a missing host - and it is what a LOCAL run (a
 * developer on a PAT, with no `DATABRICKS_CLIENT_ID`) is always missing. Without
 * all four the pool cannot be built, the cache silently degrades to in-memory, and
 * every redeploy signs out every user (the exact symptom this exists to prevent).
 *
 * `@dbx-tools/appkit`'s `createApp` would normally do this via `autoConfigure`,
 * but it gates that on a `lakebase()` plugin being registered - and this app
 * registers none, because it has no server to mount Lakebase routes on. Calling
 * the resolver directly also lets the gate be stricter than `autoConfigure` is:
 *
 *   - It runs ONLY when a Lakebase env var is present. A tunnel is a wrapper
 *     around someone else's app and must not invent infrastructure, so with
 *     nothing bound it skips rather than falling through the resolver's
 *     list-or-CREATE-a-project path.
 *   - `autoCreate: false` for the same reason, in case a project happens to exist.
 *   - Every failure is a WARNING, never a throw. The cache is an optimization for
 *     session durability; admission still requires a code delivered to an
 *     allow-listed address, so a gate with a memory cache is safe, just forgetful.
 */
export async function resolveCacheStorageEnv(): Promise<boolean> {
  if (!env.text(LAKEBASE_ENV)) {
    logger.info(
      `no ${env.name(LAKEBASE_ENV)} - the gate cache stays in memory; sessions and codes will not survive a restart`,
    );
    return false;
  }
  try {
    const resolved = await resolveLakebaseConnection(
      { autoCreate: false },
      AbortSignal.timeout(LAKEBASE_RESOLVE_TIMEOUT_MS),
    );
    applyLakebaseToEnv(resolved);
    // `??=` so an explicitly configured PGUSER stays authoritative. The lookup
    // falls back to the workspace API and returns undefined rather than throwing,
    // so a failure here just leaves the pool to find its own username.
    const user = await getUsernameWithApiLookup({});
    if (user) process.env.PGUSER ??= user;
    logger.info("lakebase resolved for the gate cache", {
      host: resolved.host,
      database: resolved.database,
      endpoint: resolved.endpoint,
      user: process.env.PGUSER,
    });
    return true;
  } catch (error) {
    logger.warn(
      "could not resolve lakebase - the gate cache stays in memory; sessions and codes will not survive a restart",
      { error },
    );
    return false;
  }
}

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

  // Before `createApp`, because AppKit resolves the cache's storage during it and
  // reads the connection out of `process.env` when it does. See the function's
  // docs for why the gate resolves this itself.
  await resolveCacheStorageEnv();

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
        // The code rides in the SUBJECT and the preheader, not just the body:
        // those two strings are the whole of a push notification, and a
        // notification is what mobile autofill reads. See `codeEmailSubject`.
        subject: codeEmailSubject(code, opts.subject),
        body: codeEmailHtmlBody(code, opts),
      },
      from,
      undefined,
      { text: codeEmailTextBody(code, opts), preview: codeEmailPreview(code, opts) },
    );
  };

  // `createApp` namespaces each plugin's exports on the handle by manifest name;
  // `handle.authGate` is the in-process gate API the proxy drives.
  //
  // `autoConfigure: false` because {@link resolveCacheStorageEnv} above already
  // did the one piece of it this app wants, on this app's terms.
  const handle = await createApp({
    autoConfigure: false,
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
