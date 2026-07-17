/**
 * Error normalization helpers: collapse the ubiquitous
 * `err instanceof Error ? err.message : String(err)` dance into a single
 * call, walk `cause` / `AggregateError` chains, and coerce any thrown
 * value into a real `Error`. Dependency-free and browser-safe.
 */

import { tokenizeWithOptions } from "./string";

/**
 * Normalize any thrown value into an `Error`. Returns `value` unchanged
 * when it already is an `Error`, otherwise wraps its {@link errorMessage}
 * in a fresh `Error`. Use when a consumer needs a real `Error` object
 * (React error state, `reject`, rethrow) rather than just a printable
 * string.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

/**
 * Extract a human-readable message from any thrown value. Returns
 * `value.message` when `value` is an `Error`, otherwise coerces via
 * `String(value)`. Collapses the ubiquitous
 *
 * ```ts
 * err instanceof Error ? err.message : String(err)
 * ```
 *
 * dance into a single helper, useful for log attributes and any other
 * "give me something printable" context.
 */
export function errorMessage(value: unknown): string {
  const message = errorMessages(value).next().value;
  return message ?? String(value);
}

/**
 * Yield `message` / `errorCode` strings from every node in the error
 * tree (see {@link errorNodes}). Used by {@link errorMessage} and
 * message predicates elsewhere.
 */
export function* errorMessages(value: unknown): Generator<string, void, undefined> {
  for (const node of errorNodes(value)) {
    if (typeof node === "object") {
      for (const key of ["message", "errorCode"]) {
        if (key in node) {
          const value = (node as Record<string, unknown>)[key];
          if (typeof value === "string" && value) {
            yield value;
          }
        }
      }
    } else if (typeof node === "string" && node) {
      yield node;
    }
  }
}

/**
 * Depth-first walk of an error value: the root, then `errors` (e.g.
 * `AggregateError`) and `cause` chains. Cycle-safe via a `seen` set.
 */
export function* errorNodes(err: unknown): Generator<NonNullable<unknown>, void, undefined> {
  const seen = new Set<unknown>();

  function* visit(node: unknown): Generator<NonNullable<unknown>, void, undefined> {
    if (node === undefined || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) {
        yield* visit(child);
      }
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    yield node;
    if (typeof node === "object") {
      for (const key of ["errors", "cause"]) {
        if (key in node) {
          const value = (node as Record<string, unknown>)[key];
          yield* visit(value);
        }
      }
    }
  }
  yield* visit(err);
}

/**
 * Lazy view over a thrown value for HTTP-status + message classification.
 * Status comes from the last positive `statusCode` / `code` on the error tree;
 * messages/tokens come from every `message` / `errorCode` field (including
 * `cause` and `AggregateError.errors`). Build with {@link errorContext}.
 */
export type ErrorContext = ErrorContextImpl;

class ErrorContextImpl {
  private _statusCode: number | undefined;
  private _messages: string[] | undefined;
  private _messageTokens: string[] | undefined;

  constructor(private readonly err: NonNullable<unknown>) {}

  /** Last positive `statusCode` / `code` found on the error tree, else `undefined` (0 ignored). */
  get statusCode(): number | undefined {
    if (this._statusCode === undefined) {
      outer: for (const node of errorNodes(this.err)) {
        if (typeof node !== "object" || node === null) continue;
        for (const key of ["statusCode", "code"] as const) {
          if (!(key in node)) continue;
          const value = (node as Record<string, unknown>)[key];
          if (typeof value === "number" && value > 99 && value < 600) {
            this._statusCode = value;
            break outer;
          }
        }
      }
      if (this._statusCode === undefined) {
        this._statusCode = -1;
      }
    }
    return this._statusCode == -1 ? undefined : this._statusCode;
  }

  /** Every `message` / `errorCode` string in the error tree. */
  get messages(): string[] {
    if (this._messages === undefined) {
      this._messages = [...errorMessages(this.err)];
    }
    return this._messages;
  }

  /** Lowercased tokens from {@link messages}. */
  get messageTokens(): string[] {
    if (this._messageTokens === undefined) {
      this._messageTokens = [...tokenizeWithOptions({ lowerCase: true }, ...this.messages)];
    }
    return this._messageTokens;
  }

  /** True for any 4xx status or message tokens `not exist` / `not found`. */
  get notAccessible(): boolean {
    if (this.hasStatusCode(4)) return true;
    return this.hasMessage("not", "exist") || this.hasMessage("not", "found");
  }

  /**
   * Match HTTP status. Pass a full code (`404`) or a class (`4` for any 4xx).
   * Extra filters are OR'd. `false` when no status is on the error tree.
   */
  hasStatusCode(statusCodeFilter: number, ...statusCodeFilters: number[]): boolean {
    const code = this.statusCode;
    if (code) {
      for (const filter of [statusCodeFilter, ...statusCodeFilters]) {
        const match = (filter < 100 ? Math.trunc(code / 100) : code) === filter;
        if (match) return true;
      }
    }
    return false;
  }

  /**
   * True when every token from the filter phrase(s) appears in
   * {@link messageTokens}. Each argument is tokenized on non-alphanumeric
   * boundaries (e.g. `hasMessage("not", "found")` or `hasMessage("not found")`).
   */
  hasMessage(messageFilter: string, ...messageFilters: string[]): boolean {
    return [messageFilter, ...messageFilters]
      .flatMap((filter) => Array.from(tokenizeWithOptions({ lowerCase: true }, filter)))
      .every((filterToken) => this.messageTokens.includes(filterToken));
  }
}

/** Build an {@link ErrorContext} for status + message checks. `null` / `undefined` become `{}`. */
export function errorContext(err: unknown): ErrorContext {
  return new ErrorContextImpl(err ?? {});
}
