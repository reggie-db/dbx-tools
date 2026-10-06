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

/** Request schema for sending an email one-time password. */
export const authRequestSchema = z.object({
  email: z.string().describe("Address to email a one-time code to, if it is authorized."),
});
/** Validated request for an email one-time password. */
export type AuthRequest = z.infer<typeof authRequestSchema>;

/** Response schema for an accepted one-time-password request. */
export const authRequestResultSchema = z.object({
  ok: z.literal(true),
  retryAfter: z.number().optional(),
});
/** Accepted one-time-password request result and optional retry delay. */
export type AuthRequestResult = z.infer<typeof authRequestResultSchema>;

/** Request schema for verifying an email one-time password. */
export const authVerifySchema = z.object({
  email: z.string(),
  code: z.string(),
});
/** Email address and code submitted to establish a session. */
export type AuthVerify = z.infer<typeof authVerifySchema>;

/** Response schema for one-time-password verification. */
export const authVerifyResultSchema = z.object({
  ok: z.boolean(),
  retryAfter: z.number().optional(),
});
/** Verification outcome and optional retry delay. */
export type AuthVerifyResult = z.infer<typeof authVerifyResultSchema>;

/** Response schema returned after clearing an authentication session. */
export const authLogoutResultSchema = z.object({
  ok: z.boolean(),
  redirectTo: z.string(),
});
/** Logout outcome plus the validated same-origin destination. */
export type AuthLogoutResult = z.infer<typeof authLogoutResultSchema>;

/** Response schema describing gate availability and the current browser session. */
export const authStatusSchema = z.object({
  authenticated: z.boolean(),
  email: z.string().optional(),
  enabled: z.boolean(),
  passkeysEnabled: z.boolean().optional(),
});
/** Gate availability, session identity, and optional passkey capability. */
export type AuthStatus = z.infer<typeof authStatusSchema>;
