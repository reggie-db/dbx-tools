import * as hash from "@dbx-tools/shared-core/hash";
import * as log from "@dbx-tools/shared-core/log";

import { AuthError } from "./errors.ts";
import type { Token } from "./types.ts";

/** Auth logger with a stable capability-specific tag. */
export function authLogger(scope: string): log.Logger {
  return log.logger(`auth:${scope}`);
}

/** Stable non-secret identifier for a credential cache key. */
export function credentialId(key: string): string {
  return hash.fnvHash(key);
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

/** Failure classification without serializing error messages or causes. */
export function failureMetadata(cause: unknown): Record<string, unknown> {
  return {
    name: cause instanceof Error ? cause.name : typeof cause,
    ...(cause instanceof AuthError ? { kind: cause.kind } : {}),
  };
}
