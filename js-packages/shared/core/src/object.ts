/**
 * Dependency-free object + iterable utilities.
 *
 * Value guards / coercions / shape types: {@link isRecord} narrows parsed JSON
 * to a record, {@link toNumber} coerces a hand-typed numeral, {@link toBoolean}
 * coerces loose truthy/falsy values, {@link toDuration} parses `1h30m` /
 * `2 milliseconds` to millis, {@link toDate} coerces a date/ISO string/epoch
 * number/relative duration (`toDate` and `toDuration` fall back to each other, so
 * either accepts both readings), {@link optional}
 * spreads a field only when it is present, {@link deepEqual} compares
 * structurally, {@link isSerializableValue} rejects anything a JSON round trip
 * would lose or coerce, {@link toStableKey} canonicalizes a value so an identity
 * can be derived from it, and {@link NameLike}/{@link NonFunctionKeys} describe
 * object shapes.
 *
 * Iterable helpers: {@link generator} flattens mixed arguments; {@link sequence}
 * wraps source(s) in a lazy, `Array`-compatible {@link Sequence}. Every
 * transform/terminal is a standalone function operating on plain {@link
 * Container}s (see {@link map}, {@link filter}, {@link group}, ...); the {@link
 * Sequence} methods are thin forwarders over them so the same logic backs both
 * the free-function and the fluent/chained styles.
 *
 * @module
 */

/** Lazy sequence over iterable source(s). See {@link sequence}. */
export type Sequence<T> = SequenceImpl<T>;

type SequenceSource<T> = Iterable<T> | ReadonlyMap<unknown, T> | OneOrMany<T> | null | undefined;

/**
 * A non-scalar {@link Iterable} - one to treat as a collection of elements
 * rather than a scalar. {@link isContainer} narrows to this, excluding strings,
 * `String`/`RegExp` objects, and functions. {@link Collection} is the eagerly-
 * sized subset. The element defaults to `unknown` so any `Collection` is
 * assignable to a bare `Container`.
 */
export type Container<T = unknown> = Iterable<T>;

/**
 * A built-in, eagerly-sized {@link Container}: an {@link Array}, {@link Set}, or
 * {@link Map} (whose *values* are `T` - a Map iterates `[key, value]` entries,
 * so its element type differs, but its value type is `T`). All share a cheap
 * emptiness check ({@link isEmpty}).
 */
export type Collection<T> = ReadonlyArray<T> | ReadonlySet<T> | ReadonlyMap<unknown, T>;

export type OneOrMany<T> = [T, ...T[]];

/** Narrow a readonly array to a non-empty {@link OneOrMany} tuple. */
export function isOneOrMany<T = unknown>(value: readonly T[]): value is OneOrMany<T> {
  return value.length > 0;
}

/** A source accepted by a variadic op: a {@link Container} of `T`, or nothing. */
type Source<T> = Container<T> | null | undefined;

/**
 * Element type of a {@link group} bucket array: when the predicate `P` is a type
 * guard (`value is S`), the bucket is narrowed to `S & T`; otherwise it stays `T`.
 */
type GroupValue<T, P> = P extends (value: any, ...rest: any[]) => value is infer S ? S & T : T;

/** A map of group name -> predicate, as accepted by {@link group}. */
type GroupPredicates<T> = Record<string, (value: T, index: number) => boolean>;

/**
 * Type guard for a {@link Collection}: an {@link Array}, {@link Set}, or
 * {@link Map}. Narrows `value` so its element/value type is treated as `T`.
 *
 * @typeParam T - Element (or Map value) type asserted for the collection.
 * @param value - Value to test.
 * @returns `true` (narrowing `value` to {@link Collection}<`T`>) for a
 *   built-in array/set/map.
 */
export function isCollection<T = unknown>(value: unknown): value is Collection<T> {
  return Array.isArray(value) || value instanceof Set || value instanceof Map;
}

/**
 * `true` when a {@link Collection} has no elements. Uses `length` for arrays
 * and `size` for {@link Set}/{@link Map}.
 *
 * @param collection - The array, set, or map to test.
 */
export function isEmpty(
  collection: Collection<unknown> | Record<string, unknown>,
  options?: { recursive?: boolean },
): boolean {
  function visit(value: unknown, seen?: Set<unknown>): boolean {
    if (value == null) {
      return true;
    } else if (typeof value === "object") {
      if (seen?.has(value)) return true;
      seen?.add(value);
      if (Array.isArray(value)) {
        return value.length === 0 || (seen ? value.every((item) => visit(item, seen)) : false);
      }
      if (value instanceof Set) {
        return value.size === 0 || (seen ? [...value].every((item) => visit(item, seen)) : false);
      }
      if (value instanceof Map) {
        return (
          value.size === 0 ||
          (seen ? [...value.values()].every((item) => visit(item, seen)) : false)
        );
      }
      const keys = Object.keys(value);
      if (keys.length === 0) {
        return true;
      } else if (seen) {
        return keys.every((key) => visit((value as Record<string, unknown>)[key], seen));
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
  return visit(collection, options?.recursive ? new Set() : undefined);
}

/**
 * Normalizes a source to an iterable of its `T` values, so Maps are treated
 * uniformly with arrays/sets: a {@link Map} yields its *values* (matching
 * {@link Collection}'s value-typed `T`), any other iterable yields itself. This
 * is what {@link sequence} consumes, so a `Map` contributes values everywhere
 * rather than `[key, value]` entries.
 */
export function values<T>(source: Iterable<T> | ReadonlyMap<unknown, T>): Iterable<T> {
  return source instanceof Map ? source.values() : (source as Iterable<T>);
}

/**
 * Type guard for a {@link Container} - an iterable to be treated as a collection
 * rather than a scalar.
 *
 * Deliberately excludes values that are technically iterable but should be
 * treated as scalars here - strings, `String`/`RegExp` objects, and functions -
 * so a lone string is never spread character-by-character.
 *
 * @typeParam T - Element type asserted for the iterable.
 * @param value - Value to test.
 * @returns `true` (narrowing `value` to {@link Container}<`T`>) for a non-string
 *   iterable.
 */
export function isContainer<T = unknown>(value: unknown): value is Container<T> {
  return (
    value != null &&
    typeof value !== "string" &&
    !(value instanceof String) &&
    !(value instanceof RegExp) &&
    typeof value !== "function" &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  );
}

function sequenceSources<T>(...sources: SequenceSource<T>[]): Iterable<T>[] {
  const sourceIterables: Iterable<T>[] = [];
  for (const source of sources) {
    if (source == null || (isCollection(source) && isEmpty(source))) continue;
    sourceIterables.push(values(source));
  }
  return sourceIterables;
}

/**
 * Flattens nested arrays for {@link flat}. Non-array values are wrapped as a
 * single-element iterable; depth decrements per array level.
 */
function flattenValue(value: unknown, depth: number): Iterable<unknown> {
  if (depth > 0 && Array.isArray(value)) {
    const nextDepth = Number.isFinite(depth) ? depth - 1 : depth;
    return {
      *[Symbol.iterator]() {
        for (const item of value) yield* flattenValue(item, nextDepth);
      },
    };
  }
  return [value];
}

/** Wrap a per-element transform (each element -> an iterable) as a lazy {@link Sequence}. */
function derive<T, U>(
  source: Iterable<T>,
  fn: (value: T, index: number) => Iterable<U>,
): Sequence<U> {
  return sequence({
    *[Symbol.iterator]() {
      let index = 0;
      for (const value of source) yield* fn(value, index++);
    },
  });
}

/** Like {@link derive}, but yields one value per source element (no wrapper iterable). */
function deriveOne<T, U>(source: Iterable<T>, fn: (value: T, index: number) => U): Sequence<U> {
  return sequence({
    *[Symbol.iterator]() {
      let index = 0;
      for (const value of source) yield fn(value, index++);
    },
  });
}

/**
 * Same semantics as `Array.prototype.map`, over a single {@link Container}.
 *
 * @param source - The container to map (nullish yields an empty sequence).
 * @param callback - Called per element with its index; its result is emitted.
 */
export function map<T, U>(
  source: Source<T>,
  callback: (value: T, index: number) => U,
): Sequence<U> {
  return deriveOne(sequence(source), callback);
}

/**
 * Same semantics as `Array.prototype.filter`, over a single {@link Container}.
 * A type-guard predicate narrows the resulting element type.
 *
 * @param source - The container to filter (nullish yields an empty sequence).
 * @param predicate - Keeps elements for which it returns `true`.
 */
export function filter<T, S extends T>(
  source: Source<T>,
  predicate: (value: T, index: number) => value is S,
): Sequence<S>;
export function filter<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): Sequence<T>;
export function filter<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): Sequence<T> {
  return derive(sequence(source), function* (value, index) {
    if (predicate(value, index)) yield value;
  });
}

/**
 * Concatenates the sources and yields only elements that are not `null` or
 * `undefined`, narrowing the element type to {@link NonNullable}<`T`>.
 *
 * @param sources - Containers to concatenate (nullish sources are skipped).
 */
export function nonNull<T>(...sources: readonly Source<T>[]): Sequence<NonNullable<T>> {
  return filter(sequence(...sources), (value): value is NonNullable<T> => value != null);
}

/**
 * Same semantics as `Array.prototype.flatMap`, over a single {@link Container}.
 *
 * @param source - The container to map (nullish yields an empty sequence).
 * @param callback - Returns a value or array of values, flattened one level.
 */
export function flatMap<T, U>(
  source: Source<T>,
  callback: (value: T, index: number) => U | ReadonlyArray<U>,
): Sequence<U> {
  return derive(sequence(source), function* (value, index) {
    const result = callback(value, index);
    if (Array.isArray(result)) yield* result;
    else yield result as U;
  });
}

/**
 * Same semantics as `Array.prototype.flat` (arrays only). `depth` leads so the
 * sources can stay variadic; use `depth < 1` for a no-op passthrough.
 *
 * @param depth - How many array levels to flatten.
 * @param sources - Containers to concatenate, then flatten (nullish skipped).
 */
export function flat<T>(depth: number, ...sources: readonly Source<T>[]): Sequence<T> {
  const src = sequence(...sources);
  if (depth < 1) return src;
  return derive(src, (value) => flattenValue(value, depth)) as Sequence<T>;
}

/**
 * Concatenates the sources, then lazily yields values in encounter order,
 * skipping a value only when an equal one was already yielded (`Set` /
 * SameValueZero). Uniqueness is checked per element as it is consumed.
 *
 * @param sources - Containers to concatenate (nullish sources are skipped).
 */
export function distinct<T>(...sources: readonly Source<T>[]): Sequence<T> {
  const src = sequence(...sources);
  return sequence({
    *[Symbol.iterator]() {
      const seen = new Set<T>();
      for (const value of src) {
        if (seen.has(value)) continue;
        seen.add(value);
        yield value;
      }
    },
  });
}

/**
 * Yields `source`, then each appended `item` in order (arrays spread one level),
 * mirroring `Array.prototype.concat`. `items` are scalar values/arrays, not
 * containers, so `source` stays a single leading argument.
 *
 * @param source - The leading container (nullish yields just the items).
 * @param items - Values (or arrays of values) appended after the source.
 */
export function concat<T>(
  source: Source<T>,
  ...items: readonly (T | ReadonlyArray<T>)[]
): Sequence<T> {
  const src = sequence(source);
  if (items.length === 0) return src;
  return sequence({
    *[Symbol.iterator]() {
      yield* src;
      for (const item of items) {
        if (Array.isArray(item)) yield* item;
        else yield item as T;
      }
    },
  });
}

/**
 * Yields at most `count` elements from the front of the concatenated sources.
 * `count` leads so the sources can stay variadic.
 *
 * @param count - Maximum number of elements to yield (`<= 0` yields none).
 * @param sources - Containers to concatenate (nullish sources are skipped).
 */
export function take<T>(count: number, ...sources: readonly Source<T>[]): Sequence<T> {
  if (count <= 0) return emptySequence as Sequence<T>;
  const src = sequence(...sources);
  return sequence({
    *[Symbol.iterator]() {
      let taken = 0;
      for (const value of src) {
        yield value;
        if (++taken >= count) return;
      }
    },
  });
}

/**
 * Splits the concatenated sources into one array per named predicate. Consumes
 * the input once, routing each element to the FIRST predicate it satisfies (so
 * groups are disjoint); elements matching no predicate are dropped. Type-guard
 * predicates narrow their group's element type (see {@link GroupValue}).
 * `predicates` leads so the sources can stay variadic.
 *
 * @typeParam G - The map of group name -> predicate.
 * @param predicates - Named predicates; evaluated in declaration order.
 * @param sources - Containers to concatenate (nullish sources are skipped).
 * @returns An object with the same keys, each an array of its group's elements.
 *
 * @example
 *   const { strings, fns } = group({ strings: isString, fns: isFunction }, xs);
 */
export function group<T, G extends GroupPredicates<T>>(
  predicates: G,
  ...sources: readonly Source<T>[]
): { [K in keyof G]: GroupValue<T, G[K]>[] } {
  const keys = Object.keys(predicates) as (keyof G)[];
  const buckets = new Map<keyof G, T[]>(keys.map((key) => [key, []]));
  let index = 0;
  for (const value of sequence(...sources)) {
    const i = index++;
    for (const key of keys) {
      if (predicates[key]!(value, i)) {
        buckets.get(key)!.push(value);
        break;
      }
    }
  }
  const result = {} as { [K in keyof G]: GroupValue<T, G[K]>[] };
  for (const key of keys) {
    result[key] = buckets.get(key)! as GroupValue<T, G[typeof key]>[];
  }
  return result;
}

/**
 * Same semantics as `Array.prototype.find`, over a single {@link Container}.
 * Consumes elements until a match. A type guard narrows the return type.
 */
export function find<T, S extends T>(
  source: Source<T>,
  predicate: (value: T, index: number) => value is S,
): S | undefined;
export function find<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): T | undefined;
export function find<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): T | undefined {
  let index = 0;
  for (const value of sequence(source)) {
    if (predicate(value, index++)) return value;
  }
  return undefined;
}

/**
 * Same semantics as `Array.prototype.findLast`, over a single {@link Container}.
 * Consumes the full source. A type guard narrows the return type.
 */
export function findLast<T, S extends T>(
  source: Source<T>,
  predicate: (value: T, index: number) => value is S,
): S | undefined;
export function findLast<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): T | undefined;
export function findLast<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): T | undefined {
  let index = 0;
  let match: T | undefined;
  for (const value of sequence(source)) {
    if (predicate(value, index++)) match = value;
  }
  return match;
}

/**
 * Same semantics as `Array.prototype.findIndex`, over a single {@link Container}.
 * Consumes elements until a match.
 */
export function findIndex<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): number {
  let index = 0;
  for (const value of sequence(source)) {
    if (predicate(value, index)) return index;
    index++;
  }
  return -1;
}

/**
 * Same semantics as `Array.prototype.findLastIndex`, over a single
 * {@link Container}. Consumes the full source.
 */
export function findLastIndex<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): number {
  let index = 0;
  let match = -1;
  for (const value of sequence(source)) {
    if (predicate(value, index)) match = index;
    index++;
  }
  return match;
}

/**
 * Same semantics as `Array.prototype.some`, over a single {@link Container}.
 * Short-circuits on the first match.
 */
export function some<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): boolean {
  let index = 0;
  for (const value of sequence(source)) if (predicate(value, index++)) return true;
  return false;
}

/**
 * Same semantics as `Array.prototype.every`, over a single {@link Container}.
 * Short-circuits on the first failure.
 */
export function every<T, S extends T>(
  source: Source<T>,
  predicate: (value: T, index: number) => value is S,
): boolean;
export function every<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): boolean;
export function every<T>(
  source: Source<T>,
  predicate: (value: T, index: number) => boolean,
): boolean {
  let index = 0;
  for (const value of sequence(source)) if (!predicate(value, index++)) return false;
  return true;
}

/**
 * Same semantics as `Array.prototype.forEach`, over a single {@link Container}.
 * Consumes the source.
 */
export function forEach<T>(source: Source<T>, callback: (value: T, index: number) => void): void {
  let index = 0;
  for (const value of sequence(source)) callback(value, index++);
}

/**
 * Same semantics as `Array.prototype.at` over the concatenated sources.
 * Non-negative indices scan lazily; negative indices materialize first. `index`
 * leads so the sources can stay variadic.
 *
 * @param index - Zero-based position; negative counts from the end.
 * @param sources - Containers to concatenate (nullish sources are skipped).
 */
export function at<T>(index: number, ...sources: readonly Source<T>[]): T | undefined {
  const src = sequence(...sources);
  if (index < 0) return toArray(src).at(index);
  let i = 0;
  for (const value of src) {
    if (i++ === index) return value;
  }
  return undefined;
}

export function toOneOrMany<T>(input: T | OneOrMany<T>): OneOrMany<T> {
  return Array.isArray(input) ? input : [input];
}

/**
 * Materializes the concatenated sources into a new array. Consumes single-pass
 * sources.
 *
 * @param sources - Containers to concatenate (nullish sources are skipped).
 */
export function toArray<T>(...sources: readonly Source<T>[]): readonly T[] {
  return [...sequence(...sources)];
}

/**
 * Lazy iterable sequence with `Array`-compatible transforms and terminal
 * methods. Single-pass by default; call {@link SequenceImpl.cache} to retain
 * pulled values for re-iteration. Built for generators and other sources where
 * a second pass is not guaranteed.
 *
 * The methods forward to the standalone functions of the same name - see each
 * method's `@see` - so the free-function and chained styles share one impl.
 */
class SequenceImpl<T> {
  private iterator?: Iterator<T>;
  private exhausted: boolean;

  constructor(
    private readonly source: Iterable<T>,
    private readonly buffer: T[] | undefined,
    state: { readonly exhausted?: boolean } = {},
  ) {
    this.exhausted = state.exhausted ?? false;
  }

  private get caching(): boolean {
    return this.buffer !== undefined;
  }

  /** Advance the underlying source once, creating the iterator on first use. */
  private pull(): IteratorResult<T> {
    this.iterator ??= this.source[Symbol.iterator]();
    return this.iterator.next();
  }

  *[Symbol.iterator](): Iterator<T> {
    if (!this.caching) {
      if (this.exhausted) return;
      for (let next = this.pull(); !next.done; next = this.pull()) {
        yield next.value;
      }
      this.exhausted = true;
    } else {
      // Cached: iterate like a list. Always replay the buffer from the start,
      // extending it from the source on demand until exhausted. A broken loop
      // leaves the buffer intact, so the next iteration starts over from the
      // beginning.
      const buffer = this.buffer!;
      let index = 0;
      for (;;) {
        if (index < buffer.length) {
          yield buffer[index++]!;
          continue;
        }
        if (this.exhausted) return;
        const next = this.pull();
        if (next.done) {
          this.exhausted = true;
          return;
        }
        buffer.push(next.value);
        yield next.value;
        index++;
      }
    }
  }

  /** @see {@link map} */
  map<U>(callback: (value: T, index: number) => U): Sequence<U> {
    return map(this, callback);
  }

  /** @see {@link filter} */
  filter<S extends T>(predicate: (value: T, index: number) => value is S): Sequence<S>;
  filter(predicate: (value: T, index: number) => boolean): Sequence<T>;
  filter(predicate: (value: T, index: number) => boolean): Sequence<T> {
    return filter(this, predicate);
  }

  /** @see {@link nonNull} */
  nonNull(): Sequence<NonNullable<T>> {
    return nonNull(this);
  }

  /** @see {@link flatMap} */
  flatMap<U>(callback: (value: T, index: number) => U | ReadonlyArray<U>): Sequence<U> {
    return flatMap(this, callback);
  }

  /** @see {@link flat} */
  flat(depth = 1): Sequence<T> {
    return flat(depth, this);
  }

  /** @see {@link distinct} */
  distinct(): Sequence<T> {
    return distinct(this);
  }

  /** @see {@link concat} */
  concat(...items: readonly (T | ReadonlyArray<T>)[]): Sequence<T> {
    return concat(this, ...items);
  }

  /**
   * Lazily yields this sequence followed by each iterable `source` in order.
   * Like {@link concat}, but for iterable sources (generators, other sequences,
   * `Set`, `Map`, etc.) rather than scalar values or arrays. A {@link Map}
   * source contributes its values.
   *
   * @see {@link sequence}
   */
  join(...sources: readonly SequenceSource<T>[]): Sequence<T> {
    const sourceIterables = sequenceSources(this, ...sources);
    return sequenceSources.length === 0 ? this : sequence(...sourceIterables);
  }

  /** @see {@link take} */
  take(count: number): Sequence<T> {
    return take(count, this);
  }

  /** @see {@link group} */
  group<G extends GroupPredicates<T>>(predicates: G): { [K in keyof G]: GroupValue<T, G[K]>[] } {
    return group(predicates, this);
  }

  /**
   * Returns a cached, re-iterable view of this sequence. An already-caching
   * sequence returns itself; otherwise this one-pass sequence is wrapped in a
   * new instance that retains pulled values. Iterate the returned instance, not
   * the original, to avoid competing for the same single-pass source.
   */
  cache(): Sequence<T> {
    return this.caching ? this : new SequenceImpl(this, []);
  }

  /** @see {@link find} */
  find<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined {
    return find(this, predicate);
  }

  /** @see {@link findLast} */
  findLast<S extends T>(predicate: (value: T, index: number) => value is S): S | undefined;
  findLast(predicate: (value: T, index: number) => boolean): T | undefined;
  findLast(predicate: (value: T, index: number) => boolean): T | undefined {
    return findLast(this, predicate);
  }

  /** @see {@link findIndex} */
  findIndex(predicate: (value: T, index: number) => boolean): number {
    return findIndex(this, predicate);
  }

  /** @see {@link findLastIndex} */
  findLastIndex(predicate: (value: T, index: number) => boolean): number {
    return findLastIndex(this, predicate);
  }

  /** @see {@link some} */
  some(predicate: (value: T, index: number) => boolean): boolean {
    return some(this, predicate);
  }

  /** @see {@link every} (the `S extends T` overload narrows at compile time only). */
  every<S extends T>(predicate: (value: T, index: number) => value is S): this is Sequence<S>;
  every(predicate: (value: T, index: number) => boolean): boolean;
  every(predicate: (value: T, index: number) => boolean): boolean {
    return every(this, predicate);
  }

  /** @see {@link forEach} */
  forEach(callback: (value: T, index: number) => void): void {
    forEach(this, callback);
  }

  /** @see {@link at} */
  at(index: number): T | undefined {
    return at(index, this);
  }

  /**
   * Materialize the sequence into a new array. Consumes a single-pass source; a
   * cached, exhausted sequence copies its buffer directly.
   *
   * @see {@link toArray}
   */
  toArray(): readonly T[] {
    if (this.caching && this.exhausted) return [...this.buffer!];
    return toArray(this);
  }
}

/** Shared empty sequence singleton, reusable for any element type. */
const emptySequence: Sequence<never> = new SequenceImpl([], undefined, {
  exhausted: true,
});

/**
 * Wrap one or more iterable `sources` in a single lazy {@link Sequence},
 * iterated in order. `null`/`undefined` sources are skipped; when nothing
 * remains (every source omitted, `null`, `undefined`, or an empty array /
 * `Set` / `Map`), {@link emptySequence} is returned. The result is single-pass
 * - call `.cache()` to make it re-iterable.
 *
 * A {@link Map} source contributes its values (see {@link values}), consistent
 * with {@link Collection}'s value-typed `T`.
 *
 * @typeParam T - Element type of the sequence.
 * @param sources - Iterables to concatenate, in order (`Map` sources use values).
 */
export function sequence<T>(...sources: readonly SequenceSource<T>[]): Sequence<T> {
  // Skip nullish sources and known-empty collections; normalize the rest to
  // their values so a Map contributes values rather than [key, value] entries.
  const sourceIterables = sequenceSources(...sources);
  if (sourceIterables.length === 0) return emptySequence as Sequence<T>;
  // Reuse an existing sequence as-is rather than re-wrapping it.
  if (sourceIterables.length === 1) {
    const only = sourceIterables[0]!;
    return only instanceof SequenceImpl ? (only as Sequence<T>) : new SequenceImpl(only, undefined);
  }
  return new SequenceImpl(
    {
      *[Symbol.iterator]() {
        for (const source of sourceIterables) yield* source;
      },
    },
    undefined,
  );
}

/**
 * Flattens a mix of single items and iterables into one lazy {@link Generator}.
 *
 * Arguments are emitted in order: `null`/`undefined` are skipped, non-string
 * iterables (per {@link isContainer}) are yielded element-by-element, and
 * anything else (including strings) is yielded as a single item.
 *
 * @typeParam T - Element type produced by the generator.
 * @param items - Items and/or iterables to flatten, in order.
 * @returns A generator over the flattened elements.
 */
export function* generator<T>(
  ...items: readonly (T | Iterable<T> | null | undefined)[]
): Generator<T> {
  for (const item of items) {
    if (item === null || item === undefined) {
      continue;
    } else if (isContainer(item)) {
      yield* item;
    } else {
      yield item;
    }
  }
}

// ---------------------------------------------------------------------------
// Object value guards, coercions, and structural equality
// ---------------------------------------------------------------------------

/** Minimal shape for objects that expose an optional `name` (e.g. AppKit plugins). */
export interface NameLike {
  name?: string;
}

export type NonFunctionKeys<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? never : K;
}[keyof T];

/**
 * Narrow `value` to a plain (non-array) object. Use as a type guard
 * before indexing into / mutating parsed JSON so the access is
 * type-safe.
 *
 * @example
 * if (isRecord(parsed)) parsed.foo = 1;
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON scalar. `undefined` is deliberately absent - `JSON.stringify` drops it. */
export type SerializablePrimitive = string | number | boolean | null;

/**
 * Any value that survives a `JSON.stringify`/`JSON.parse` round trip unchanged.
 *
 * Use it instead of `unknown` on a boundary that will serialize its input - a
 * message payload, a cache entry, a config blob written to disk - so a `Date`,
 * a `Map`, or a class instance is a compile error at the call site rather than a
 * receiver quietly getting a string or `{}`. {@link isSerializableValue} is the
 * runtime half, for input the compiler cannot vouch for.
 */
export type SerializableValue =
  SerializablePrimitive | SerializableValue[] | { [key: string]: SerializableValue };

/**
 * True when `value` survives a JSON round trip with no loss and no coercion.
 *
 * Stricter than "`JSON.stringify` did not throw", because that succeeds while
 * silently CHANGING the value: a `Date` becomes a string, `NaN` and `Infinity`
 * become `null`, a `Map` becomes `{}`, and `undefined` disappears from an object
 * or turns into `null` inside an array. Each of those reaches the far side as
 * something other than what was sent, so all of them are rejected here.
 *
 * Rejected: non-finite numbers, `undefined`, functions, symbols, bigints, class
 * instances and anything else with a prototype other than `Object.prototype` or
 * `null` (`Date`, `Map`, `Set`, `RegExp`, `Buffer`), and any object graph
 * containing a cycle. Accepted: strings, booleans, `null`, finite numbers, plain
 * objects, arrays, and nestings of those.
 *
 * Narrows to {@link SerializableValue} rather than asserting, so it also serves
 * as the validator for untrusted input - a request body, a decoded notification
 * payload - where the answer should be a 400 and not a throw. Never throws.
 *
 * Distinct from {@link deepEqual}'s notion of comparable: that one HANDLES
 * `Date`/`Map`/`Set` structurally, while this one rejects them precisely because
 * JSON cannot carry them.
 *
 * @param ancestors Cycle-detection set for the recursive walk. Internal; callers
 *   pass one value.
 *
 * @example
 * isSerializableValue({ a: [1, "x", null] }); // true
 * isSerializableValue({ at: new Date() });    // false - would become a string
 * isSerializableValue(Number.NaN);            // false - would become null
 */
export function isSerializableValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): value is SerializableValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isSerializableValue(entry, ancestors))
    : Object.values(value).every((entry) => isSerializableValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

/**
 * Canonical string for a structured value, for deriving a STABLE IDENTITY from
 * it - an advisory-lock id, a channel name, a cache key.
 *
 * The guarantee is two-way, which is what makes it safe to hash: values that
 * should share an identity produce the same string (object key order does not
 * matter), and values that should not are never conflated. Every token carries
 * its type, so `1` and `"1"` differ; a string carries its length, so
 * `["a", "bc"]` and `["ab", "c"]` differ; arrays keep order while object keys
 * are sorted.
 *
 * `JSON.stringify` cannot do this job - key order leaks in, `undefined` vanishes,
 * `1` and `"1"` collide after quoting is stripped, and a cycle throws a
 * `TypeError` naming neither the value nor the caller's intent.
 *
 * Deliberately strict where a silent answer would be a WRONG identity rather
 * than a missing one, since two callers disagreeing about a lock or a channel is
 * invisible until it corrupts something. Throws `TypeError` on a cycle, on a
 * non-finite number (`NaN` is not equal to itself, so it cannot have a stable
 * identity), and on a `function` or `symbol` (no meaningful value identity).
 * `undefined` and `null` are accepted as distinct tokens.
 *
 * `Date` is canonicalized by instant, unlike the hash canonicalizer in
 * `./hash.ts`, which folds every `Date` onto one token. Prefer this function when
 * distinctness is a correctness requirement; prefer `hash.fnvHash` when a short,
 * collision-tolerant digest is enough.
 *
 * @param value - The value to canonicalize.
 * @param seen - Cycle-detection set for the recursive walk. Internal; callers
 *   pass one value.
 *
 * @example
 * toStableKey({ a: 1, b: 2 }) === toStableKey({ b: 2, a: 1 }); // true
 * toStableKey(1) !== toStableKey("1");                         // true
 */
export function toStableKey(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      // Length-prefixed so concatenated neighbours cannot be re-split
      // differently: `["a","bc"]` and `["ab","c"]` must not agree.
      return `string:${value.length}:${value}`;
    case "boolean":
      return `boolean:${value}`;
    case "bigint":
      return `bigint:${value}`;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Stable keys require finite numbers");
      // `-0 === 0` but they stringify differently, so pick one spelling.
      return `number:${Object.is(value, -0) ? "-0" : value}`;
    case "undefined":
      return "undefined";
    case "object": {
      if (seen.has(value)) throw new TypeError("Stable keys cannot contain cycles");
      seen.add(value);
      try {
        if (value instanceof Date) return `date:${value.toISOString()}`;
        if (Array.isArray(value)) {
          return `array:[${value.map((item) => toStableKey(item, seen)).join(",")}]`;
        }
        if (value instanceof Set) {
          // Sorted by canonical form, so insertion order does not leak.
          return `set:[${[...value]
            .map((item) => toStableKey(item, seen))
            .sort()
            .join(",")}]`;
        }
        const entries: Iterable<[unknown, unknown]> =
          value instanceof Map ? value : Object.entries(value);
        return `${value instanceof Map ? "map" : "object"}:{${[...entries]
          .map(([key, item]) => `${toStableKey(key, seen)}=${toStableKey(item, seen)}`)
          .sort()
          .join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`Unsupported stable key type: ${typeof value}`);
  }
}

/**
 * `{ [key]: value }` when `value` is present, otherwise `undefined` - so an
 * absent optional field stays ABSENT when spread, rather than becoming an
 * explicit `undefined` that `exactOptionalPropertyTypes` rejects.
 *
 * Spelling that inline costs a repeated, double-evaluated ternary per field
 * (`...(v ? { key: v } : {})`), which is how config resolvers end up computing
 * the same value twice.
 *
 * @example
 * return {
 *   ...optional("appId", env.text("MICROSOFT_APP_ID")),
 *   ...optional("endpoint", config.endpoint),
 * };
 */
export function optional<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | undefined {
  return value === null || value === undefined ? undefined : ({ [key]: value } as Record<K, V>);
}

/**
 * Options for {@link toNumber}.
 *
 * Both switches turn OFF a leniency that is helpful for a hand-typed setting but
 * wrong when the string's other characters carry meaning. {@link toDate} and
 * {@link toDuration} disable both, since a space inside `2026 08 02` is a field
 * separator and a percent has no epoch or millisecond reading.
 */
export interface ToNumberOptions {
  /**
   * Whether internal digit-group separators are stripped, so `"1,000"` and
   * `"1 000"` read as `1000`. Defaults to `true`.
   *
   * Placement is not validated when enabled, so `"1,00,0"` also reads as `1000`.
   * Disable it when whitespace or a comma delimits FIELDS rather than grouping
   * digits, because stripping them silently fuses those fields into one number.
   */
  separators?: boolean;
  /**
   * Whether a trailing percent sign divides the result by `100`, so `"25%"` reads
   * as `0.25`. Defaults to `true`.
   *
   * Disable it where a percentage has no meaning, so `"25%"` is a miss rather
   * than a number two orders of magnitude away from what the text says.
   */
  percent?: boolean;
}

/**
 * Coerce a loose numeric value to a real, FINITE `number`, or `undefined` when it
 * carries no numeric meaning.
 *
 * The one place a hand-typed number is interpreted, alongside {@link toBoolean},
 * {@link toDate}, and {@link toDuration}. Reach for it instead of `Number(x)` or a
 * hand-rolled numeric regex: bare `Number` maps `""`, `null`, `[]`, and
 * whitespace to `0` and anything else to `NaN`, so a caller has to re-check the
 * result every time, and ad hoc regexes tend to drift in what they accept.
 *
 * Accepts: a finite `number`; a `bigint`; or a decimal string with an optional
 * leading sign, leading/trailing whitespace, whitespace after the sign,
 * digit-group separators (`"1,000"`, `"1 000"`), a bare fraction (`".5"`), a
 * trailing point (`"1."`), scientific notation (`"1e3"`), and an optional
 * trailing percent sign (`"25%"`, `"1.5 %"`). A trailing `%` divides the parsed
 * value by `100`, so `"25%"` becomes `0.25`.
 *
 * Separators are stripped without validating their placement, so `"1,00,0"` reads
 * as `1000`; this is a coercion for hand-typed configuration, not a locale-aware
 * validator. Anything else, including `NaN`, `Infinity`, an empty or
 * whitespace-only string, `null`, `undefined`, a boolean, multiple signs,
 * malformed exponents, misplaced percent signs, or `"12px"`, returns `undefined`.
 *
 * Returns `undefined` rather than throwing, matching the other coercions, so it
 * composes naturally with `??` fallbacks.
 *
 * @example
 * toNumber("1,000");   // 1000
 * toNumber(" -2.5 ");  // -2.5
 * toNumber("1e3");     // 1000
 * toNumber("12.5 %");  // 0.125
 * toNumber("");        // undefined  (Number("") would be 0)
 * toNumber("12px");    // undefined
 * toNumber("1 000", { separators: false }); // undefined
 */
export function toNumber(value: unknown, options: ToNumberOptions = {}): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  } else if (typeof value === "bigint") {
    return toNumber(Number(value), options);
  } else if (typeof value === "string") {
    // Strip surrounding whitespace, whitespace after a leading sign, digit-group
    // separators (both `,` and the space in `"1 000"`), leaving a bare numeral for
    // the shape test below to accept or reject.
    const text = value.replace(
      options.separators === false ? /(^\s+|\s+$)/g : /(^\s+|\s+$|(?<=^[+-])\s+|(?<=\d)\s+|,)/g,
      "",
    );
    if (text) {
      const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%)?$/i);
      if (match && !(match[2] && options.percent === false)) {
        const number = Number(match[1]);
        return toNumber(match[2] ? number / 100 : number, options);
      }
    }
  } else {
    // A boxed `Number`, or anything with a numeric `toString`. `String(value)`
    // routes it back through the string branch, which rejects what is not numeric.
    return toNumber(String(value), options);
  }
  return undefined;
}

/**
 * Coerce a loose boolean-ish value to a real `boolean`, or `undefined`
 * when it can't be interpreted. Recognizes `true`/`t`/`on`/`1`/`yes`/`y`
 * and their negatives (case- and whitespace-insensitive for strings), as
 * well as the numbers `1` and `0`.
 */
export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  } else if (typeof value === "string") {
    value = value.trim().toLowerCase();
    if (
      value === "true" ||
      value == "t" ||
      value === "on" ||
      value === "1" ||
      value === "yes" ||
      value === "y"
    ) {
      return true;
    } else if (
      value === "false" ||
      value == "f" ||
      value === "off" ||
      value === "0" ||
      value === "no" ||
      value === "n"
    ) {
      return false;
    }
  } else if (typeof value === "number") {
    if (value === 1) return true;
    else if (value === 0) return false;
  }
  return undefined;
}

/**
 * Largest value read as epoch SECONDS rather than milliseconds.
 *
 * `1e11` seconds is the year 5138 and `1e11` ms is 1973-03-03, so every value a
 * caller realistically means as millis is above the line and every value they
 * mean as seconds is below it. The ambiguity is unavoidable - the two units share
 * a number line - so the split is placed where neither side has a plausible
 * claim.
 */
const SECONDS_CEILING = 1e11;

/**
 * A number for {@link toDate} and {@link toDuration}, read with none of
 * {@link toNumber}'s string leniencies.
 *
 * Both leniencies are actively harmful here. A space or comma separates FIELDS in
 * a date (`2026 08 02` would fuse into the epoch `20260802`), and a percentage has
 * no reading as an instant or a length of time, so `25%` must be a miss rather
 * than `250ms`.
 */
function toBareNumber(value: unknown): number | undefined {
  return toNumber(value, { separators: false, percent: false });
}

/**
 * Milliseconds per unit, keyed by SINGULAR alias. {@link toDuration} retries a
 * lookup without a trailing `s`, so every plural spelling is covered without
 * listing it (`ms` is already singular, hence its own entry).
 *
 * `m` is MINUTES and months need `mo`, following the near-universal convention
 * (`ms`, `date`, cron prose); month and year are calendar approximations (30 /
 * 365 days) because a duration has no anchor date to be exact against.
 */
const DURATION_UNITS: ReadonlyArray<readonly [ms: number, aliases: readonly string[]]> = [
  [1, ["ms", "msec", "millisecond", "milli"]],
  [1000, ["s", "sec", "second"]],
  [60_000, ["m", "min", "minute"]],
  [3_600_000, ["h", "hr", "hour"]],
  [86_400_000, ["d", "day"]],
  [604_800_000, ["w", "wk", "week"]],
  [2_592_000_000, ["mo", "mon", "month"]],
  [31_536_000_000, ["y", "yr", "year"]],
];

const DURATION_UNIT_MS: ReadonlyMap<string, number> = new Map(
  DURATION_UNITS.flatMap(([ms, aliases]) => aliases.map((alias) => [alias, ms] as const)),
);

/** One `<amount><unit>` term inside a duration string. */
const DURATION_TERM = /([+-]?)(\d+(?:\.\d+)?)\s*([a-z]+)/g;

/**
 * Options for {@link toDate}.
 *
 * The mirror of {@link ToDurationOptions}: each function can fall back to the
 * other, so each has one switch turning that fallback off.
 */
export interface ToDateOptions {
  /**
   * Whether a {@link toDuration} expression is read as an instant relative to
   * now, so `-7d` and `7 days ago` become `now - 7 days`. Defaults to `true`.
   *
   * Set `false` when the value must be a real date and a relative expression
   * should be a miss - a stored timestamp, a user-supplied `Date` header, an
   * `expires_at` field - since a duration silently resolving against the current
   * clock makes the same input mean something different on every call. Also what
   * {@link toDuration} passes when it recurses, so the two cannot bounce a value
   * between them forever.
   */
  parseDuration?: boolean;
}

/**
 * Options for {@link toDuration}.
 *
 * The mirror of {@link ToDateOptions}: each function can fall back to the other,
 * so each has one switch turning that fallback off.
 */
export interface ToDurationOptions {
  /**
   * Whether a {@link toDate} value is read as the signed offset from now, so
   * `2026-08-02` becomes however long until (or since) that instant. Defaults to
   * `true`.
   *
   * Set `false` when only a length of time is meaningful - a timeout, a poll
   * interval, a cache TTL - because a date would otherwise yield a plausible but
   * wrong number that also drifts with the clock. Also what {@link toDate} passes
   * when it recurses.
   */
  parseDate?: boolean;
}

/**
 * Coerce a loose duration to MILLISECONDS, or `undefined` when it can't be
 * interpreted.
 *
 * Deliberately lenient, because these values are typed by hand into env vars,
 * CLI flags, and config files: whitespace between amount and unit is optional and
 * unlimited, units are case-insensitive, plurals and the common abbreviations are
 * equivalent (`2ms` === `2 milliseconds`, `1h` === `1 hr` === `1 Hour`), `and` and
 * thousands separators are ignored (`1,500 ms`, `1 hour and 30 minutes`), and
 * terms compose (`1h30m`). A plain `number` passes through as milliseconds.
 *
 * Signs are supported so a duration can express an OFFSET rather than only a
 * length: a leading `-` (or a trailing `ago`) makes the result negative, and an
 * unsigned term inherits the previous term's sign, so `-1h30m` is -90 minutes
 * rather than -60 + 30. {@link toDate} uses that to turn `-7d` / `7 days ago`
 * into an instant relative to now.
 *
 * An UNKNOWN unit fails the whole parse rather than being skipped - `1 fortnight`
 * returning `1` silently would be worse than returning nothing - which is also
 * what keeps {@link toDate} from mistaking `1 Jan 2026` for a duration.
 *
 * A value that is not a duration at all is offered to {@link toDate} and, when it
 * IS a date, read as the signed offset from now (`date - now`), which makes the
 * two functions inverses: a past instant is negative, a future one positive.
 * `options.parseDate: false` turns that off when only a length of time makes
 * sense - see {@link ToDurationOptions}.
 *
 * @example
 * toDuration("30s");                    // 30_000
 * toDuration("1 hour 30 minutes");      // 5_400_000
 * toDuration("-7 days");                // -604_800_000
 * toDuration("2 weeks ago");            // -1_209_600_000
 * toDuration("2026-08-02");             // ms from now to that instant
 * toDuration("2026-08-02", { parseDate: false }); // undefined
 * toDuration("soon");                   // undefined
 */
export function toDuration(value: unknown, options: ToDurationOptions = {}): number | undefined {
  // A bare number is already milliseconds, the same reading `toDate` gives an
  // epoch value, so this must run before any date interpretation.
  const num = toBareNumber(value);
  if (num !== undefined) return num;
  if (typeof value !== "string") {
    return options.parseDate === false ? undefined : dateAsDuration(value);
  }
  let text = value
    .toLowerCase()
    .replaceAll(/[,_]/g, "")
    .replaceAll(/\band\b/g, " ")
    .trim();
  let negate = false;
  if (text.endsWith("ago")) {
    negate = true;
    text = text.slice(0, -"ago".length);
  }
  text = text.replace(/^in\b/, "").trim();
  if (!text) return undefined;

  const terms = [...text.matchAll(DURATION_TERM)];
  if (terms.length === 0) {
    return options.parseDate === false ? undefined : dateAsDuration(value);
  }

  // Everything outside the matched terms must be separators only; otherwise the
  // string is something else that merely CONTAINS a duration-shaped fragment.
  let leftover = text;
  for (const term of terms) leftover = leftover.replace(term[0], " ");
  if (leftover.trim()) {
    // A duration-shaped fragment inside other text is usually a DATE - `"2026-08-02"`
    // matches two terms and leaves separators behind.
    return options.parseDate === false ? undefined : dateAsDuration(value);
  }

  let total = 0;
  let sign = 1;
  for (const [, explicitSign, amount, unit] of terms) {
    if (explicitSign) sign = explicitSign === "-" ? -1 : 1;
    const unitMs = DURATION_UNIT_MS.get(unit) ?? DURATION_UNIT_MS.get(unit.replace(/s$/, ""));
    if (unitMs === undefined) {
      return options.parseDate === false ? undefined : dateAsDuration(value);
    }
    total += sign * Number(amount) * unitMs;
  }
  return negate ? -total : total;
}

/**
 * A date read as the signed offset from now (`date - now`), which is what makes
 * {@link toDuration} and {@link toDate} inverses of each other. Recurses with
 * duration parsing DISABLED so the two cannot hand a value back and forth
 * forever.
 */
function dateAsDuration(value: unknown): number | undefined {
  const date = toDate(value, { parseDuration: false });
  return date === undefined ? undefined : date.getTime() - Date.now();
}

/**
 * Coerce a loose date-ish value to a real `Date`, or `undefined` when it can't be
 * interpreted. Accepts, in this order:
 *
 *   - a `Date` (passed through; an invalid one is a miss);
 *   - an epoch NUMBER or numeric string, in seconds or milliseconds (see
 *     {@link SECONDS_CEILING});
 *   - `now` (and its `today` spelling), for the current instant;
 *   - a {@link toDuration} expression, resolved RELATIVE TO NOW, so `-7d`,
 *     `7 days ago`, and `in 30 minutes` are all valid instants;
 *   - anything `Date.parse` understands (`2026-08-02`, an ISO/UTC instant).
 *
 * The epoch unit inference is the reason this exists rather than
 * `new Date(value)`: a bare epoch arrives as a STRING from an env var or a CLI
 * flag as often as it arrives as a number (`date +%s`, a JSON field, a copied log
 * line), and `Date.parse("1785697899")` reads that as a YEAR, silently landing
 * 1.7 billion years out. Numeric strings are therefore routed to the epoch path,
 * never to `Date.parse`.
 *
 * The duration fallback runs LAST, after `Date.parse`, so a real date is never
 * mistaken for an offset. `options.parseDuration: false` removes it entirely when
 * the value must be an absolute instant - see {@link ToDateOptions}.
 *
 * Like {@link toBoolean} this NEVER throws and returns `undefined` for anything
 * uninterpretable, so a caller decides whether a bad value is fatal, a warning,
 * or a fallback.
 *
 * @example
 * toDate("now");               // this instant
 * toDate("2026-08-02");        // 2026-08-02T00:00:00.000Z
 * toDate("1785697899");        // seconds -> 2026-08-02T...
 * toDate(1785697899000);       // millis  -> the same instant
 * toDate("30 days ago");       // now - 30d
 * toDate("30 days ago", { parseDuration: false }); // undefined
 * toDate("nope");              // undefined
 */
export function toDate(value: unknown, options: ToDateOptions = {}): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  const epochMs = toEpochMs(value);
  if (epochMs !== undefined) return fromMs(epochMs);

  if (typeof value !== "string") return undefined;

  const text = value.trim().toLowerCase();
  if (text === "now" || text === "today") return new Date();

  const parsed = Date.parse(value.trim());
  if (!Number.isNaN(parsed)) return new Date(parsed);

  if (options.parseDuration === false) return undefined;
  // Recurses with date parsing DISABLED so the two cannot hand a value back and
  // forth forever.
  const offsetMs = toDuration(value, { parseDate: false });
  return offsetMs === undefined ? undefined : fromMs(Date.now() + offsetMs);
}

/** A `Date` for epoch `ms`, or `undefined` when it is out of representable range. */
function fromMs(ms: number): Date | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Epoch milliseconds for a numeric value/string, or `undefined` when not one,
 * applying the seconds-vs-millis inference at {@link SECONDS_CEILING}.
 */
function toEpochMs(value: unknown): number | undefined {
  const numeric = toBareNumber(value);
  if (numeric === undefined) return undefined;
  return Math.abs(numeric) < SECONDS_CEILING ? numeric * 1000 : numeric;
}

/**
 * Structural deep-equality with an optional custom comparator.
 *
 * {@link deepEqual} mirrors the semantics of the `fast-deep-equal`
 * package (handled: nested plain objects/arrays, `Map`, `Set`, `Date`,
 * `RegExp`, typed arrays, `NaN`, and `+0`/`-0` treated as equal) but is
 * dependency-free so `@dbx-tools/shared-core` keeps no runtime deps.
 *
 * The optional `comparator` short-circuits the structural walk at any
 * node: return `true`/`false` to force the result for that pair, or
 * `undefined` to defer to the built-in comparison. It is invoked for the
 * root pair and recursively for each nested pair, so a caller can, e.g.,
 * compare two domain objects by id while letting everything else fall
 * back to structural equality.
 *
 * @example
 * deepEqual({ a: 1 }, { a: 1 });                 // true
 * deepEqual([1, 2], [1, 2]);                      // true
 * deepEqual(a, b, (x, y) =>
 *   isEntity(x) && isEntity(y) ? x.id === y.id : undefined);
 */
export type DeepEqualComparator = (a: unknown, b: unknown) => boolean | undefined;

export function deepEqual(a: unknown, b: unknown, comparator?: DeepEqualComparator): boolean {
  if (comparator) {
    const decided = comparator(a, b);
    if (decided !== undefined) return decided;
  }

  if (a === b) return true;

  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    // NaN is the only value not equal to itself under `===`.
    return a !== a && b !== b;
  }

  if (a.constructor !== b.constructor) return false;

  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], bArr[i], comparator)) return false;
    }
    return true;
  }

  if (a instanceof Map) {
    const bMap = b as Map<unknown, unknown>;
    if (a.size !== bMap.size) return false;
    for (const [key, value] of a) {
      if (!bMap.has(key)) return false;
      if (!deepEqual(value, bMap.get(key), comparator)) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    const bSet = b as Set<unknown>;
    if (a.size !== bSet.size) return false;
    for (const value of a) {
      if (!bSet.has(value)) return false;
    }
    return true;
  }

  if (a instanceof Date) {
    return a.getTime() === (b as Date).getTime();
  }

  if (a instanceof RegExp) {
    const bRe = b as RegExp;
    return a.source === bRe.source && a.flags === bRe.flags;
  }

  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    const aArr = a as unknown as ArrayLike<number>;
    const bArr = b as unknown as ArrayLike<number>;
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (aArr[i] !== bArr[i]) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        comparator,
      )
    ) {
      return false;
    }
  }
  return true;
}
