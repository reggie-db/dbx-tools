/** Authentication failure with a stable category for callers and language shims. */
export class AuthError extends Error {
  constructor(
    readonly kind: "config" | "oauth" | "storage" | "lock-timeout" | "cli" | "http",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

/** Normalize arbitrary failures without erasing their original cause. */
export function authError(kind: AuthError["kind"], message: string, cause?: unknown): AuthError {
  return cause instanceof AuthError ? cause : new AuthError(kind, message, { cause });
}
