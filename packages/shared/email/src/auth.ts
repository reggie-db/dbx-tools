/**
 * Wire-format contract for the email one-time-password ACCESS GATE.
 *
 * A companion to the email add-on's send contract ({@link ./email}): where that
 * lets an agent send mail, this lets an AppKit app put an email-OTP gate in front
 * of itself - the login flow for an app exposed publicly (e.g. through a portr
 * tunnel that bypasses the Databricks front door). Pure zod so the server routes,
 * the React `AuthGate`, and any client validate against one definition.
 *
 * Flow: `POST /request` (email) -> a 6-digit code is emailed -> `POST /verify`
 * (email + code) -> an HttpOnly session cookie is set -> `GET /status` reports
 * whether the caller is authenticated. `request` ALWAYS reports success (the
 * server never reveals whether an address is allow-listed or was actually sent a
 * code - anti-enumeration).
 *
 * @module
 */

import { z } from "zod";

/**
 * Name of the HttpOnly cookie the tunnel gate stores its session JWT in. Shared
 * so the proxy (which sets it) and any client-side code agree on one name.
 */
export const SESSION_COOKIE_NAME = "dbx-tools-auth";

/** `POST /api/email/auth/request` body: ask for a code to be emailed. */
export const authRequestSchema = z.object({
  email: z.string().describe("Address to email a one-time code to, if it is allowed."),
});

/** {@link authRequestSchema} */
export type AuthRequest = z.infer<typeof authRequestSchema>;

/**
 * `POST /api/email/auth/request` response. Always `{ ok: true }` on a
 * well-formed request, regardless of whether the address was allowed or a code
 * was actually sent - the client cannot distinguish an allowed address from a
 * rejected one (anti-enumeration). `retryAfter` is set only when the caller is
 * rate-limited, so a UI can show a cooldown without leaking allow-list state.
 */
export const authRequestResultSchema = z.object({
  ok: z.literal(true).describe("Always true for a well-formed request (anti-enumeration)."),
  retryAfter: z
    .number()
    .optional()
    .describe("Seconds to wait before requesting again, when rate-limited."),
});

/** {@link authRequestResultSchema} */
export type AuthRequestResult = z.infer<typeof authRequestResultSchema>;

/** `POST /api/email/auth/verify` body: submit the emailed code. */
export const authVerifySchema = z.object({
  email: z.string().describe("The address the code was requested for."),
  code: z.string().describe("The one-time code from the email."),
});

/** {@link authVerifySchema} */
export type AuthVerify = z.infer<typeof authVerifySchema>;

/**
 * `POST /api/email/auth/verify` response. `ok` true means the code matched and
 * an HttpOnly session cookie was set; false means it did not (wrong, expired, or
 * too many attempts) - the message is deliberately generic. `retryAfter` is set
 * when the failure was a rate limit.
 */
export const authVerifyResultSchema = z.object({
  ok: z.boolean().describe("True when the code matched and a session was established."),
  retryAfter: z.number().optional().describe("Seconds to wait before retrying, when rate-limited."),
});

/** {@link authVerifyResultSchema} */
export type AuthVerifyResult = z.infer<typeof authVerifyResultSchema>;

/** `GET /api/email/auth/status` response: is the caller authenticated, and as whom. */
export const authStatusSchema = z.object({
  authenticated: z.boolean().describe("True when the request carries a valid session."),
  email: z.string().optional().describe("The authenticated address, when authenticated."),
  enabled: z
    .boolean()
    .describe("True when the gate is active; false means the app is open (no login needed)."),
});

/** {@link authStatusSchema} */
export type AuthStatus = z.infer<typeof authStatusSchema>;
