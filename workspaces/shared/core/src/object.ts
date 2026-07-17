/**
 * Dependency-free object + iterable utilities.
 *
 * Value guards / coercions / shape types: {@link isRecord} narrows parsed JSON
 * to a record, {@link toBoolean} coerces loose truthy/falsy values, {@link
 * deepEqual} compares structurally, and {@link NameLike}/{@link NonFunctionKeys}
 * describe object shapes.
 *
 * Iterable helpers: {@link generator} flattens mixed arguments; {@link sequence}
 * wraps source(s) in a lazy, `Array`-compatible {@link Sequence}. Every
 * transform/terminal is a standalone function operating on plain {@link
 * Container}s (see {@link map}, {@link filter}, {@link group}, ...); the {@link
 * Sequence} methods are thin forwarders over them so the same logic backs both
 * the free-function and the fluent/chained styles.
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
    if (value == null) return true;
    else if (typeof value === "object") {
      if (seen?.has(value)) return true;
      seen?.add(value);
      if (Array.isArray(value)) {
        return value.length === 0 || (seen ? value.every((item) => visit(item, seen)) : false);
      }
      if (value instanceof Set) {
        return (
          value.size === 0 || (seen ? [...value].every((item) => visit(item, seen)) : false)
        );
      }
      if (value instanceof Map) {
        return (
          value.size === 0 ||
          (seen ? [...value.values()].every((item) => visit(item, seen)) : false)
        );
      }
      const keys = Object.keys(value);
      if (keys.length === 0) return true;
      else if (seen) {
        return keys.every((key) => visit((value as Record<string, unknown>)[key], seen));
      } else {
        return false
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

export function toOneOrMany<T>(input: (T | OneOrMany<T>)): OneOrMany<T> {
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
      for (; ;) {
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
    ...sources: readonly SequenceSource<T>[]
  ): Sequence<T> {
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
export function sequence<T>(
  ...sources: readonly SequenceSource<T>[]
): Sequence<T> {
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

/**
 * Coerce a loose boolean-ish value to a real `boolean`, or `undefined`
 * when it can't be interpreted. Recognizes `true`/`t`/`on`/`1`/`yes`/`y`
 * and their negatives (case- and whitespace-insensitive for strings), as
 * well as the numbers `1` and `0`.
 */
export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  else if (typeof value === "string") {
    value = value.trim().toLowerCase();
    if (
      value === "true" ||
      value == "t" ||
      value === "on" ||
      value === "1" ||
      value === "yes" ||
      value === "y"
    )
      return true;
    else if (
      value === "false" ||
      value == "f" ||
      value === "off" ||
      value === "0" ||
      value === "no" ||
      value === "n"
    )
      return false;
  } else if (typeof value === "number") {
    if (value === 1) return true;
    else if (value === 0) return false;
  }
  return undefined;
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
