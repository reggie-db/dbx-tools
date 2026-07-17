/**
 * Cancellation-aware async primitives: an abortable {@link sleep}, an
 * {@link AbortController} linker ({@link tieAbortSignal}), and a periodic
 * {@link poll} generator. Dependency-free; `poll`'s `"distinct"` filter
 * uses the local {@link deepEqual}.
 */
import { deepEqual } from "./object";

/**
 * Per-iteration context handed to {@link PollProducer} and the
 * predicate on each step of a {@link poll} loop. Bundles the
 * iteration metadata so the call signatures stay stable as `poll`
 * grows additional fields.
 *
 * `signal` is owned by `poll`: it tracks the external
 * `PollOptions.signal` (when supplied) and also fires when the
 * consumer breaks out of the loop, so producers can forward it to
 * any in-flight work (`fetch`, SDK calls, etc.) and have a single
 * cancellation source tear down both the request and the loop.
 *
 * `attributes` is a mutable scratchpad shared across every
 * iteration of a single `poll` run. The same object reference is
 * passed each call so writes from one iteration are visible to the
 * next - useful for stashing per-loop state (retry counters, start
 * timestamps, anything you'd otherwise close over via a let).
 * Generic `A` lets callers type the bag; defaults to
 * `Record<string, unknown>`.
 */
export interface PollContext<T, A = Record<string, unknown>> {
  /** Zero-based iteration index (`0` on the first call). */
  attempt: number;
  /** Value yielded on the prior iteration; `undefined` on the first. */
  previous: T | undefined;
  /** Cancellation handle. Always defined; forward to in-flight work. */
  signal: AbortSignal;
  /** Per-run mutable scratchpad shared across iterations. */
  attributes: A;
}

/** One step of a {@link poll} loop. See {@link PollContext}. */
export type PollProducer<T, A = Record<string, unknown>> = (
  ctx: PollContext<T, A>,
) => T | PromiseLike<T>;

export interface PollOptions<T, A = Record<string, unknown>> {
  /** Milliseconds to wait between polls. */
  intervalMs: number;
  /**
   * Predicate evaluated against each yielded value: return `true` to
   * keep it, `false` to skip it (without stopping the loop). May be
   * sync or async - a `PromiseLike<boolean>` is awaited before the
   * decision is made. Receives the same {@link PollContext} as the
   * producer (same `signal`, same `attributes` bag). The special
   * value `"distinct"` skips a value that deep-equals the previous
   * one.
   */
  filter?: ((value: T, ctx: PollContext<T, A>) => boolean | PromiseLike<boolean>) | "distinct";
  /**
   * Predicate evaluated against each yielded value: return `true` to
   * keep polling, `false` to stop. May be sync or async. Omit to poll
   * forever (the consumer stops by breaking out of the loop or by
   * aborting `signal`).
   */
  predicate?: (value: T, ctx: PollContext<T, A>) => boolean | PromiseLike<boolean>;
  /**
   * External cancellation handle. Tied into the internal signal that
   * `poll` hands to `producer`, so aborting it tears down both the
   * in-flight request and the inter-poll sleep.
   */
  signal?: AbortSignal;
  /**
   * Hard upper bound on the total lifetime of the poll loop, in
   * milliseconds. When the budget elapses, `poll` aborts its internal
   * signal so the in-flight producer and inter-poll sleep both tear
   * down promptly, and the loop throws the `TimeoutError`
   * `DOMException` produced by `AbortSignal.timeout(timeoutMs)`. The
   * budget starts ticking the moment the generator is created.
   */
  timeoutMs?: number;
  /**
   * Initial value for `ctx.attributes`. Defaults to `{}`. The same
   * object is reused across iterations, so callers can pre-populate
   * fields (timers, retry counters, etc.) and the producer /
   * predicate can mutate them in place.
   */
  attributes?: A;
}

/**
 * Async iterable that drives a periodic poll. Each iteration:
 *
 *   1. Builds a {@link PollContext} (`attempt`, `previous`, `signal`,
 *      shared `attributes`) and calls `producer(ctx)`; yields the
 *      resolved value (subject to `filter`).
 *   2. Evaluates `options.predicate(value, ctx)`; stops when it
 *      returns (or resolves to) `false`.
 *   3. Sleeps `options.intervalMs` before the next attempt.
 *
 * The first call runs immediately (no leading sleep) so the consumer
 * sees a value without waiting an interval. Errors thrown by
 * `producer` propagate through the generator.
 *
 * `poll` always creates an internal `AbortController` and exposes
 * `internal.signal` as `ctx.signal`, so producers can rely on a
 * defined signal without a nullish check. The external
 * `options.signal` is tied in, and a `try/finally` aborts the
 * internal signal when the consumer breaks out of the `for await`
 * (or the loop throws), so any producer work still holding the
 * signal sees the cancellation too.
 *
 * @example
 * for await (const msg of poll(
 *   async ({ signal }) =>
 *     client.genie.getMessage({ ... }, { abortSignal: signal }),
 *   {
 *     intervalMs: 250,
 *     predicate: (m) => !TERMINAL_STATUSES.has(m.status),
 *     signal: controller.signal,
 *   },
 * )) {
 *   render(msg);
 * }
 */
export async function* poll<T, A = Record<string, unknown>>(
  producer: PollProducer<T, A>,
  options: PollOptions<T, A>,
): AsyncGenerator<T, void, void> {
  const { intervalMs, predicate, signal, attributes, timeoutMs } = options;
  const controller = new AbortController();
  if (signal) tieAbortSignal(controller, signal);
  if (timeoutMs !== undefined) {
    tieAbortSignal(controller, AbortSignal.timeout(timeoutMs));
  }
  // Single shared attributes object so writes from one iteration are
  // visible on the next. `{} as A` is safe because either the caller
  // supplied `attributes` (typed) or `A` defaulted to the unknown
  // record shape (in which case `{}` satisfies it).
  const sharedAttributes = attributes ?? ({} as A);
  try {
    let previous: T | undefined;
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      const ctx: PollContext<T, A> = {
        attempt,
        previous,
        signal: controller.signal,
        attributes: sharedAttributes,
      };
      const value = await producer(ctx);
      if (options.filter) {
        if (options.filter === "distinct") {
          if (deepEqual(previous, value)) continue;
        } else if (!(await options.filter(value, ctx))) continue;
      }
      yield value;
      if (predicate && !(await predicate(value, ctx))) return;
      await sleep(intervalMs, controller.signal);
      previous = value;
    }
  } finally {
    controller.abort();
  }
}

/**
 * Tie a child `AbortController` to a parent signal. The child aborts
 * whenever the parent aborts; aborting the child does not affect the
 * parent (so a fetch-level cancel doesn't tear down the main poll loop).
 */
export function tieAbortSignal(child: AbortController, parent?: AbortSignal): void {
  if (!parent) return;
  else if (parent.aborted) {
    child.abort(parent.reason);
    return;
  }
  parent.addEventListener("abort", () => child.abort(parent.reason), {
    once: true,
  });
}

/**
 * Promisified `setTimeout` that wakes up early (and rejects with
 * `signal.reason`) when `signal` aborts mid-wait. Short-circuits to a
 * rejected promise when the signal is already aborted on entry, so the
 * abort path is consistent regardless of whether the wait actually
 * started.
 *
 * Use as the building block for any "wait, but cancel cleanly" pattern -
 * inter-poll backoff, pacing loops, retry timers, long-poll budgets - so
 * cancellation always rejects with the caller's `signal.reason` rather
 * than silently resolving after the timer expires.
 *
 * @example
 * await sleep(250, req.signal);
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
