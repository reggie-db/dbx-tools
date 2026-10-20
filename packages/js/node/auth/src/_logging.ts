import { fnvHash } from "@dbx-tools/shared-core";
import { type Logger, logger } from "@dbx-tools/shared-core";

import { AuthError } from "./_errors.ts";
import type { Token } from "./_types.ts";

/** Auth logger with a stable capability-specific tag. */
export function authLogger(scope: string): Logger {
  return logger(`auth:${scope}`);
}

/** Stable non-secret identifier for a credential cache key. */
export function credentialId(key: string): string {
  return fnvHash(key);
}

/** Secret-free token lifecycle metadata for debug output. */
export function tokenMetadata(token: Token | undefined, now = new Date()): Record<string, unknown> {
  if (!token) return { present: false };
  const expiryMs = token.expiry ? Date.parse(token.expiry) : undefined;
  return {
    present: true,
    tokenType: token.tokenType,
    scopeCount: token.scopes.length,
    hasRefreshToken: Boolean(token.refreshToken),
    hasExpiry: Boolean(token.expiry),
    ...(expiryMs !== undefined && Number.isFinite(expiryMs)
      ? {
          expired: expiryMs <= now.getTime(),
          expiresInSeconds: Math.round((expiryMs - now.getTime()) / 1000),
        }
      : {}),
  };
}

/** Failure classification with the normalized exception retained for diagnostics. */
export function failureMetadata(cause: Error): Record<string, unknown> {
  return {
    error: cause,
    ...(cause instanceof AuthError ? { kind: cause.kind } : {}),
  };
}
