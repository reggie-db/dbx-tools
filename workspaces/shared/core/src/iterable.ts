/**
 * Dependency-free iterable utilities. {@link generator} flattens mixed arguments;
 * {@link sequence} wraps source(s) in a lazy, `Array`-compatible {@link Sequence}.
 *
 * Every transform/terminal is a standalone function operating on plain
 * {@link Container}s (see {@link map}, {@link filter}, {@link group}, ...); the
 * {@link Sequence} methods are thin forwarders over them so the same logic backs
 * both the free-function and the fluent/chained styles.
 */

/** Lazy sequence over iterable source(s). See {@link sequence}. */
export type Sequence<T> = SequenceImpl<T>;

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
 * The result of {@link SequenceImpl.consume}: a front-of-sequence split.
 * `consumed` is materialized eagerly; `remaining` stays lazy;
 * {@link Consumed.restore} rebuilds the original sequence from the two.
 *
 * @typeParam T - Element type of the split sequence.
 */
export interface Consumed<T> {
  /** The (at most `count`) leading elements pulled eagerly from the front. */
  readonly consumed: readonly T[];
  /**
   * A lazy {@link Sequence} over the elements after {@link consumed}.
   */
  readonly remaining: Sequence<T>;
  /**
   * Rebuilds the original, whole sequence. A cached source is already
   * re-iterable from the start, so it is returned as-is; a single-pass source
   * has had its {@link consumed} head drained off the front, so {@link consumed}
   * is prepended back onto {@link remaining}.
   */
  restore(): Sequence<T>;
}

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
export function isEmpty(collection: Collection<unknown>): boolean {
  return "size" in collection ? collection.size === 0 : collection.length === 0;
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
      if (predicates[key](value, i)) {
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
  join(
    ...sources: readonly (Iterable<T> | ReadonlyMap<unknown, T> | null | undefined)[]
  ): Sequence<T> {
    if (sources.length === 0) return this;
    return sequence(this, ...sources);
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

  /**
   * Splits the sequence at `count`: eagerly pulls up to `count` leading
   * elements into {@link Consumed.consumed} (fewer if the source is shorter),
   * and exposes whatever follows lazily as {@link Consumed.remaining}. A single
   * iterator is shared, so `remaining` continues exactly where `consumed`
   * stopped - nothing is dropped or replayed between them.
   *
   * {@link Consumed.restore} rebuilds the original sequence: a caching sequence
   * replays from its buffer, so it is returned as-is; a single-pass sequence has
   * had its head drained, so `consumed` is prepended back onto `remaining`.
   *
   * @param count - How many leading elements to pull (`<= 0` consumes none).
   * @returns The {@link Consumed} split of this sequence.
   */
  consume(count: number): Consumed<T> {
    // Capture up-front: a caching sequence replays from index 0 on every fresh
    // iteration, so `this` remains a faithful copy of the whole sequence and
    // restore can hand it back directly; a single-pass sequence cannot.
    const iterator = this[Symbol.iterator]();
    const consumed: T[] = [];
    for (let i = 0; i < count; i++) {
      const next = iterator.next();
      if (next.done) break;
      consumed.push(next.value);
    }
    // Wrap the SAME, partially-advanced iterator so the tail resumes in place.
    const remaining = sequence<T>({ [Symbol.iterator]: () => iterator });
    return {
      consumed,
      remaining,
      restore: () => (this.caching ? this : sequence(consumed, remaining)),
    };
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

  /** @see {@link every} */
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
export function sequence<T>(
  ...sources: readonly (Iterable<T> | ReadonlyMap<unknown, T> | null | undefined)[]
): Sequence<T> {
  // Skip nullish sources and known-empty collections; normalize the rest to
  // their values so a Map contributes values rather than [key, value] entries.
  const sequenceSources: Iterable<T>[] = [];
  for (const source of sources) {
    if (source == null || (isCollection(source) && isEmpty(source))) continue;
    sequenceSources.push(values(source));
  }
  if (sequenceSources.length === 0) return emptySequence as Sequence<T>;
  // Reuse an existing sequence as-is rather than re-wrapping it.
  if (sequenceSources.length === 1) {
    const only = sequenceSources[0]!;
    return only instanceof SequenceImpl ? (only as Sequence<T>) : new SequenceImpl(only, undefined);
  }
  return new SequenceImpl(
    {
      *[Symbol.iterator]() {
        for (const source of sequenceSources) yield* source;
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
    if (item === null || item === undefined) continue;
    else if (isContainer(item)) {
      yield* item;
    } else {
      yield item;
    }
  }
}
