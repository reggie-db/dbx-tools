/** Authentication failure with a stable category for callers and language shims. */
export class AuthError extends Error {
  constructor(
    readonly kind: "config" | "oauth" | "cli",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}
