/**
 * Short, deterministic non-cryptographic hashing and id minting.
 *
 * {@link fnvHash} / {@link fnvHashWithOptions} produce a stable FNV-1a
 * digest over arbitrary structured input; {@link toBase32} encodes a
 * 32-bit integer compactly; {@link id} mints v4 UUIDs (or short hex
 * slices). All browser-safe - built on `globalThis.crypto`, no
 * `node:crypto` import. **Never** use these for tokens, signatures, or
 * anything an attacker shouldn't be able to forge.
 *
 * @module
 */

/**
 * Mint a v4 UUID, or a short hex slice of one when `length` is set.
 *
 * - `id()` returns a full RFC 4122 v4 UUID. Pick this when global
 *   uniqueness matters: long-running batches, ids that cross a storage /
 *   process boundary, anything that may collide across machines.
 * - `id(length)` returns the first `length` hex chars of a fresh UUID
 *   with dashes stripped (e.g. `id(8) -> "a3f1c92b"`). Pick this when the
 *   id has to be short / typeable and the scope is bounded - cache keys
 *   local to a request, slug suffixes. `length <= 0` throws.
 *
 * Built on `globalThis.crypto.randomUUID()` so the same function works in
 * Node (>= 19) and modern browsers without a polyfill.
 *
 * @example
 * id();   // "123e4567-e89b-12d3-a456-426614174000"
 * id(8);  // "a3f1c92b"
 */
export function id(length?: number): string {
  if (length !== undefined && length <= 0) {
    throw new Error("Length must be greater than 0");
  }
  const id = globalThis.crypto.randomUUID();
  if (length !== undefined) {
    return id.replace(/-/g, "").slice(0, length);
  }
  return id;
}

/**
 * Short, deterministic FNV-1a hash over one or more values. Wraps
 * {@link fnvHashWithOptions} with all defaults: 6-char Crockford-style
 * base-32 output (digits + lowercase, minus `i`/`l`/`o`/`u`).
 * Browser-safe (no `node:crypto`).
 *
 * Accepts any mix of primitives, arrays, plain objects, `Map`s, and
 * `Set`s; nested structures are walked deterministically so the hash is
 * order-stable for objects / maps / sets and order-sensitive for arrays.
 * Cycles are detected and folded into a `circular:` marker.
 *
 * Use for cache keys, slug suffixes, log correlation ids, and other
 * "give me something short and stable" needs - **never** for tokens or
 * signatures. FNV-1a is a non-cryptographic hash.
 *
 * @example
 * fnvHash("databricks-claude-sonnet-4-6"); // "k3p9q7"
 * fnvHash([1, 2, 3]) !== fnvHash([3, 2, 1]);
 */
export function fnvHash(...values: unknown[]): string {
  return fnvHashWithOptions({}, ...values);
}

/**
 * Configurable counterpart to {@link fnvHash}.
 *
 * Options:
 *   - `length` (default `6`): number of base-32 chars to return. Capped
 *     at 7 - the underlying digest is 32 bits, which base-32-encodes to
 *     at most 7 chars. Output is left-padded with the alphabet's zero
 *     character so short digests still hit the requested width.
 *   - `alphabet` (default Crockford-style
 *     `"0123456789abcdefghjkmnpqrstvwxyz"`): 32 distinct characters used
 *     to encode the digest. Throws when not exactly 32 unique chars.
 *   - `digest` (default `0x811c9dc5`, the FNV-1a offset basis): the seed
 *     the running digest starts from. Useful for namespacing so
 *     otherwise-identical inputs hashed under different namespaces never
 *     collide, and for chaining hashes across pipeline stages.
 *
 * The hash is **not** stable across changes to the alphabet or `length` -
 * those tune the output, not the digest input.
 *
 * @example
 * fnvHashWithOptions({ length: 4 }, "user@example.com");        // 4 chars
 * fnvHashWithOptions({ digest: nsHash }, key) !== fnvHash(key); // namespaced
 */
export function fnvHashWithOptions(
  options: { length?: number; alphabet?: string; digest?: number } = {},
  ...values: unknown[]
): string {
  const { length = 6 } = options;

  let digest = options.digest ?? 0x811c9dc5;

  for (const value of hashAttributes(values)) {
    for (let i = 0; i < value.length; i++) {
      digest ^= value.charCodeAt(i);
      digest = Math.imul(digest, 0x01000193);
    }
  }
  const alphabet = base32Alphabet(options.alphabet);
  return toBase32(digest, alphabet, true).padStart(7, alphabet[0]).slice(0, Math.min(length, 7));
}

/**
 * Walk an arbitrary value as a stream of canonicalized string tokens
 * suitable for feeding into a streaming hash like FNV-1a. Used by
 * {@link fnvHashWithOptions} so structured inputs hash deterministically
 * without a stringification round-trip through `JSON.stringify` (which
 * silently drops `undefined`, has no canonical key order, and can't
 * represent cycles).
 *
 * Canonicalization rules:
 *
 *   - `null` / `undefined` collapse to `null:`.
 *   - Primitives (`string` / `number` / `boolean`) are tagged with their
 *     `typeof` so `"1"` and `1` produce different digests.
 *   - Arrays preserve order: `[1,2]` and `[2,1]` hash differently.
 *   - Plain objects emit keys in lexical order of each key's own
 *     hash-token stream, so `{a:1,b:2}` and `{b:2,a:1}` collapse.
 *   - `Map` keys go through the same key-sort path as objects.
 *   - `Set`s are sorted by each element's hash-token stream and emit only
 *     the elements, so insertion order doesn't leak into the digest.
 *   - Cycles emit `circular:` and stop descending.
 *   - Anything else falls through to a `${typeof}:${JSON.stringify}`
 *     token.
 */
function* hashAttributes(input: any, seen?: WeakSet<object>): Generator<string> {
  if (input === null || input === undefined) {
    yield "null:";
    return;
  }

  const inputType = typeof input;
  if (inputType === "string" || inputType === "number" || inputType === "boolean") {
    yield `${inputType}:`;
    yield input.toString();
    return;
  }
  seen ??= new WeakSet<object>();

  if (inputType === "object") {
    if (seen.has(input)) {
      yield "circular:";
      return;
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        yield "[";
        for (const item of input) {
          yield* hashAttributes(item, seen);
          yield ",";
        }
        yield "]";
        return;
      } else {
        const hashAttributeKeys = (keys: Array<unknown>) => {
          return keys
            .map((key) => {
              const keyHashAttributes = [...hashAttributes(key, seen)];
              return {
                key,
                keyHashAttributes,
                sortKey: keyHashAttributes.join("\0"),
              };
            })
            .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        };
        if (input instanceof Set) {
          yield "[";
          for (const hashAttributeKey of hashAttributeKeys(Array.from(input))) {
            yield* hashAttributeKey.keyHashAttributes;
            yield ",";
          }
          yield "]";
          return;
        } else {
          yield "{";
          const keys = input instanceof Map ? Array.from(input.keys()) : Object.keys(input);
          for (const hashAttributeKey of hashAttributeKeys(keys)) {
            const value =
              input instanceof Map
                ? input.get(hashAttributeKey.key)
                : input[hashAttributeKey.key as keyof typeof input];
            yield* hashAttributeKey.keyHashAttributes;
            yield ":";
            yield* hashAttributes(value, seen);
            yield ",";
          }
          yield "}";
          return;
        }
      }
    } finally {
      seen.delete(input);
    }
  }
  yield `${inputType}:${JSON.stringify(input)}`;
}

/**
 * Default Crockford-style base-32 alphabet: digits `0-9` then lowercase
 * letters with `i`, `l`, `o`, `u` removed. Output is safe to drop into
 * URLs, filenames, and `[A-Za-z0-9_-]`-bound marker captures.
 */
const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Resolve a caller-supplied alphabet against the default. Returns the
 * default when the caller passed nothing; otherwise validates the
 * override is exactly 32 unique chars. Throws on bad alphabets so callers
 * fail fast instead of producing silently-degraded encodings.
 */
function base32Alphabet(alphabet?: string): string {
  if (alphabet === undefined) return BASE32_ALPHABET;
  else if (new Set(alphabet).size !== 32) {
    throw new Error("Base32 alphabet must contain 32 unique characters");
  }
  return alphabet;
}

/**
 * Encode a 32-bit unsigned integer as base-32 using the default
 * Crockford-style alphabet (or `alphabet` when provided). The encoding
 * has **no** zero-padding by default - `toBase32(0)` returns the
 * alphabet's zero character, otherwise the result is the minimal number
 * of digits that fits the value. Pad / truncate at the call site when you
 * need a fixed width.
 *
 * `disableAlphabetValidation` skips the unique-32-char check for hot
 * paths that have already validated the alphabet. The function still
 * requires `alphabet.length === 32` either way.
 *
 * @example
 * toBase32(0);        // "0"
 * toBase32(31);       // "z"
 * toBase32(0xdeadbe); // "6vmtw"
 */
export function toBase32(
  value: number,
  alphabet?: string,
  disableAlphabetValidation?: boolean,
): string {
  if (!disableAlphabetValidation) {
    alphabet = base32Alphabet(alphabet);
  }
  if (alphabet!.length !== 32) {
    throw new Error(`Base32 alphabet must contain exactly 32 characters, got ${alphabet!.length}`);
  }
  value >>>= 0;
  if (value === 0) {
    return alphabet![0]!;
  }
  let result = "";
  while (value > 0) {
    result = alphabet![value & 31] + result;
    value >>>= 5;
  }
  return result;
}
