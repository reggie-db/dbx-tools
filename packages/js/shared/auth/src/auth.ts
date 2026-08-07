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

export const authStatusSchema = z.object({
  authenticated: z.boolean(),
  email: z.string().optional(),
  enabled: z.boolean(),
  passkeysEnabled: z.boolean().optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;
