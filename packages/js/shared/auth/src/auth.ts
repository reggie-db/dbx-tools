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

/** Canonical mount for Better Auth and the dbx-tools compatibility routes. */
export const AUTH_BASE_PATH = "/api/email/auth";

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

export const SESSION_COOKIE_NAME = "dbx-tools-auth";

export const authRequestSchema = z.object({
  email: z.string().describe("Address to email a one-time code to, if it is authorized."),
});
export type AuthRequest = z.infer<typeof authRequestSchema>;

export const authRequestResultSchema = z.object({
  ok: z.literal(true),
  retryAfter: z.number().optional(),
});
export type AuthRequestResult = z.infer<typeof authRequestResultSchema>;

export const authVerifySchema = z.object({
  email: z.string(),
  code: z.string(),
});
export type AuthVerify = z.infer<typeof authVerifySchema>;

export const authVerifyResultSchema = z.object({
  ok: z.boolean(),
  retryAfter: z.number().optional(),
});
export type AuthVerifyResult = z.infer<typeof authVerifyResultSchema>;

export const authLogoutResultSchema = z.object({
  ok: z.boolean(),
  redirectTo: z.string(),
});
export type AuthLogoutResult = z.infer<typeof authLogoutResultSchema>;

export const authStatusSchema = z.object({
  authenticated: z.boolean(),
  email: z.string().optional(),
  enabled: z.boolean(),
  passkeysEnabled: z.boolean().optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;
