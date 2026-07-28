/**
 * Browser-safe JSON helpers for the parse-untrusted-text case.
 *
 * `JSON.parse` throws on malformed input and returns `any`, so almost every
 * caller in this repo wrapped it in the same try/catch and then re-narrowed the
 * result by hand. {@link parse} collapses the try/catch (a bad document yields
 * the fallback instead of throwing) and {@link parseRecord} adds the narrowing
 * that untrusted JSON almost always needs before it can be indexed.
 *
 * Use these when the document comes from OUTSIDE the process - a request body,
 * an env var, a config file, a subprocess's stdout, a third-party API. Keep
 * bare `JSON.parse` where a throw is the correct outcome (an internally
 * produced document that must be well-formed).
 *
 * These deliberately do NOT validate shape beyond "is it a record". Reach for
 * a zod schema when the payload has a contract; these only get you from `string`
 * to a safely typed starting point.
 *
 * @module
 */

import { isRecord } from "./object.ts";

/**
 * Parse JSON text, returning `fallback` (default `undefined`) instead of
 * throwing when `text` is absent or malformed.
 *
 * The return type is caller-asserted, exactly like `JSON.parse` - this only
 * removes the try/catch, it does not validate. Prefer {@link parseRecord} or a
 * schema when the result is indexed.
 *
 * @example
 * const config = json.parse<Config>(await readFile(path, "utf8"));
 * const tags = json.parse(process.env.TAGS, []);
 */
export function parse<T = unknown>(text: unknown, fallback: T): T;
export function parse<T = unknown>(text: unknown): T | undefined;
export function parse<T = unknown>(text: unknown, fallback?: T): T | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse JSON text that is expected to be an object, returning `undefined` when
 * it is absent, malformed, or parses to a non-record (an array, a bare string,
 * `null`, ...).
 *
 * This is the common case for manifests, env-var config blobs, and untyped API
 * payloads: {@link parse} followed by {@link isRecord}, so the result can be
 * indexed without an `as Record<string, unknown>` cast.
 *
 * @example
 * const manifest = json.parseRecord(await readFile("package.json", "utf8")) ?? {};
 * const name = manifest.name;
 */
export function parseRecord(text: unknown): Record<string, unknown> | undefined {
  const parsed = parse(text);
  return isRecord(parsed) ? parsed : undefined;
}
