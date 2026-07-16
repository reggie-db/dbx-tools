/**
 * Fluent, callable predicate combinators that preserve TypeScript type guards.
 *
 * A Predicate<T, U> is:
 * - Callable as `(value: T) => value is U`
 * - Composable through `.and()`, `.or()`, and `.negate()`
 *
 * Ordinary boolean predicates are treated as narrowing to `T`, meaning they
 * do not narrow the input type by themselves. Composed predicates passed to
 * `.and()` / `.or()` may return any value; they are tested for truthiness.
 */

/** An ordinary boolean predicate. */
export type PredicateFunction<T> = (value: T) => boolean;

/** A predicate that narrows T to U. */
export type TypePredicateFunction<T, U extends T> = (value: T) => value is U;

/** A predicate tested for truthiness when composed with `.and()` / `.or()`. */
export type PredicateInput<T> = (value: T) => unknown;

/**
 * Extracts the narrowed type from a type predicate.
 *
 * Ordinary boolean predicates do not narrow, so they produce T.
 */
type NarrowedBy<T, P> = P extends (value: any) => value is infer U ? Extract<U, T> : T;

/** Intersects the narrowed types produced by a tuple of predicates. */
type AndNarrowed<T, P extends readonly PredicateInput<T>[], Result = T> = P extends readonly [
  infer First,
  ...infer Rest extends readonly PredicateInput<T>[],
]
  ? AndNarrowed<T, Rest, Result & NarrowedBy<T, First>>
  : Result;

/** Unions the narrowed types produced by a tuple of predicates. */
type OrNarrowed<T, P extends readonly PredicateInput<T>[], Result = never> = P extends readonly [
  infer First,
  ...infer Rest extends readonly PredicateInput<T>[],
]
  ? OrNarrowed<T, Rest, Result | NarrowedBy<T, First>>
  : Result;

/**
 * A callable predicate with fluent composition methods.
 *
 * T is the accepted input type.
 * U is the type established when the predicate returns true.
 */
export interface Predicate<T, U extends T = T> {
  (value: T): value is U;

  /**
   * Returns a predicate requiring this predicate and every supplied predicate
   * to match.
   *
   * Type guards are intersected. Additional predicates are checked against the
   * type already established by this predicate.
   */
  and<const P extends readonly PredicateInput<U>[]>(
    ...predicates: P
  ): Predicate<T, Extract<U & AndNarrowed<U, P>, T>>;

  /**
   * Returns a predicate requiring this predicate or any supplied predicate
   * to match.
   *
   * Type guards are unioned. Because an ordinary boolean predicate could
   * accept any value of `U`, including one causes the resulting predicate to
   * narrow only to `U`.
   */
  or<const P extends readonly PredicateInput<U>[]>(
    ...predicates: P
  ): Predicate<T, Extract<U | OrNarrowed<U, P>, T>>;

  /**
   * Returns the logical inverse of this predicate.
   *
   * For a type predicate narrowing T to U, the result narrows to
   * Exclude<T, U>.
   */
  negate(): Predicate<T, Exclude<T, U>>;
}

/** Coerce a predicate result to boolean the way `if (...)` does. */
function isTruthy<T>(test: (value: T) => unknown): PredicateFunction<T> {
  return (value) => Boolean(test(value));
}

/**
 * Creates the callable predicate object.
 *
 * The public generic behavior is provided by Predicate<T, U>. Runtime
 * composition coerces predicate results to boolean; type predicates are
 * ordinary boolean functions at runtime.
 */
function buildPredicate<T, U extends T>(test: (value: T) => unknown): Predicate<T, U> {
  const check = isTruthy(test);
  const callable = ((value: T): value is U => check(value)) as (value: T) => value is U;

  return Object.assign(callable, {
    and<const P extends readonly PredicateInput<U>[]>(
      ...predicates: P
    ): Predicate<T, Extract<U & AndNarrowed<U, P>, T>> {
      type Result = Extract<U & AndNarrowed<U, P>, T>;
      return buildPredicate<T, Result>(
        (value) => check(value) && predicates.every((predicate) => isTruthy(predicate)(value as U)),
      );
    },

    or<const P extends readonly PredicateInput<U>[]>(
      ...predicates: P
    ): Predicate<T, Extract<U | OrNarrowed<U, P>, T>> {
      type Result = Extract<U | OrNarrowed<U, P>, T>;
      return buildPredicate<T, Result>(
        (value) => check(value) || predicates.some((predicate) => isTruthy(predicate)(value as U)),
      );
    },

    negate(): Predicate<T, Exclude<T, U>> {
      return buildPredicate<T, Exclude<T, U>>((value) => !check(value));
    },
  }) as Predicate<T, U>;
}

/**
 * Wraps a type predicate while preserving its narrowed type.
 */
export function create<T, U extends T>(
  predicate: TypePredicateFunction<T, U>,
): Predicate<T, U>;

/**
 * Wraps an ordinary boolean or truthy predicate.
 */
export function create<T>(predicate: PredicateInput<T>): Predicate<T, T>;

export function create<T, U extends T = T>(
  predicate: TypePredicateFunction<T, U> | PredicateInput<T>,
): Predicate<T, U> {
  return buildPredicate<T, U>(predicate);
}
