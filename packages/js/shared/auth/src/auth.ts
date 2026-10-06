/**
 * Browser-safe passwordless authentication wire contracts.
 *
 * Better Auth owns its native endpoint payloads. These schemas cover the
 * dbx-tools compatibility and gate-status surface shared by tunnel transports
 * and React hosts.
 *
 * @module
 */

import { z } from "zod";

import { AUTH_BASE_PATH } from "./_route.ts";

export { AUTH_BASE_PATH };

/**
 * True only for the auth mount itself or one of its descendants.
 *
 * Segment-aware matching prevents lookalike application routes such as
 * `/api/email/authz` from being treated as public authentication endpoints.
 */
export function isAuthPath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? path;
  return pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`);
}

/** Shared Better Auth session-cookie name used by browser and server packages. */
export const SESSION_COOKIE_NAME = "dbx-tools-auth";

export const authRequestSchema = z
  .object({
    email: z.string().describe("Address to email a one-time code to, if it is authorized."),
  })
  .describe("Validated request for an email one-time password.");

export type AuthRequest = z.infer<typeof authRequestSchema>;

export const authRequestResultSchema = z
  .object({
    ok: z.literal(true).describe("Always true for an accepted one-time-password request."),
    retryAfter: z.number().optional().describe("Seconds to wait before requesting another code."),
  })
  .describe("Accepted one-time-password request result and optional retry delay.");

export type AuthRequestResult = z.infer<typeof authRequestResultSchema>;

export const authVerifySchema = z
  .object({
    email: z.string().describe("Address that received the one-time code."),
    code: z.string().describe("One-time password submitted to establish a session."),
  })
  .describe("Email address and code submitted to establish a session.");

export type AuthVerify = z.infer<typeof authVerifySchema>;

export const authVerifyResultSchema = z
  .object({
    ok: z.boolean().describe("True when the code was accepted and a session was created."),
    retryAfter: z.number().optional().describe("Seconds to wait before trying another code."),
  })
  .describe("Verification outcome and optional retry delay.");

export type AuthVerifyResult = z.infer<typeof authVerifyResultSchema>;

export const authLogoutResultSchema = z
  .object({
    ok: z.boolean().describe("True when the session cookie was cleared."),
    redirectTo: z.string().describe("Validated same-origin destination after logout."),
  })
  .describe("Logout outcome plus the validated same-origin destination.");

export type AuthLogoutResult = z.infer<typeof authLogoutResultSchema>;

export const authStatusSchema = z
  .object({
    authenticated: z.boolean().describe("True when the browser holds a valid session."),
    email: z.string().optional().describe("Signed-in address when a session exists."),
    enabled: z.boolean().describe("True when the passwordless gate is configured."),
    passkeysEnabled: z.boolean().optional().describe("True when WebAuthn passkeys are available."),
  })
  .describe("Gate availability, session identity, and optional passkey capability.");

export type AuthStatus = z.infer<typeof authStatusSchema>;
