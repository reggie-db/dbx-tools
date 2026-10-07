/** Minimal standards-compatible AbortController globals for PythonMonkey bundles. */

export interface AbortGlobalTarget {
  AbortController?: typeof AbortController;
  AbortSignal?: typeof AbortSignal;
  DOMException?: typeof DOMException;
  Event?: typeof Event;
  setTimeout?: typeof setTimeout;
}

type AbortListener = EventListenerOrEventListenerObject;

/** Install one coherent AbortController/AbortSignal pair without replacing a complete native pair. */
export function installAbortGlobals(globals: AbortGlobalTarget = globalThis): void {
  if (globals.AbortController && globals.AbortSignal) {
    if (typeof globals.AbortSignal.timeout !== "function") {
      Object.defineProperty(globals.AbortSignal, "timeout", {
        configurable: true,
        value: (milliseconds: number) => nativeTimeout(globals, milliseconds),
      });
    }
    return;
  }

  const abortReason = () => exception(globals, "AbortError", "This operation was aborted");
  const timeoutReason = () => exception(globals, "TimeoutError", "The operation timed out");

  class PythonAbortSignal {
    static abort(reason?: unknown): AbortSignal {
      const controller = new PythonAbortController();
      controller.abort(reason);
      return controller.signal;
    }

    static timeout(milliseconds: number): AbortSignal {
      validateDelay(milliseconds);
      const controller = new PythonAbortController();
      const schedule = globals.setTimeout ?? setTimeout;
      schedule(() => controller.abort(timeoutReason()), milliseconds);
      return controller.signal;
    }

    readonly #listeners = new Map<AbortListener, boolean>();
    #aborted = false;
    #reason: unknown;
    onabort: ((this: AbortSignal, event: Event) => unknown) | null = null;

    get aborted(): boolean {
      return this.#aborted;
    }

    get reason(): unknown {
      return this.#reason;
    }

    throwIfAborted(): void {
      if (this.#aborted) throw this.#reason;
    }

    addEventListener(
      type: string,
      listener: AbortListener | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (type !== "abort" || listener === null) return;
      const once = typeof options === "object" && options.once === true;
      this.#listeners.set(listener, once);
    }

    removeEventListener(type: string, listener: AbortListener | null): void {
      if (type === "abort" && listener !== null) this.#listeners.delete(listener);
    }

    dispatchEvent(event: Event): boolean {
      if (event.type !== "abort") return true;
      this.onabort?.call(this as unknown as AbortSignal, event);
      for (const [listener, once] of [...this.#listeners]) {
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
        if (once) this.#listeners.delete(listener);
      }
      return !event.defaultPrevented;
    }

    abort(reason?: unknown): void {
      if (this.#aborted) return;
      this.#aborted = true;
      this.#reason = reason === undefined ? abortReason() : reason;
      const event = globals.Event ? new globals.Event("abort") : ({ type: "abort" } as Event);
      this.dispatchEvent(event);
      this.#listeners.clear();
    }
  }

  class PythonAbortController {
    readonly signal = new PythonAbortSignal() as unknown as AbortSignal;

    abort(reason?: unknown): void {
      (this.signal as unknown as PythonAbortSignal).abort(reason);
    }
  }

  globals.AbortSignal = PythonAbortSignal as unknown as typeof AbortSignal;
  globals.AbortController = PythonAbortController as unknown as typeof AbortController;
}

function nativeTimeout(globals: AbortGlobalTarget, milliseconds: number): AbortSignal {
  validateDelay(milliseconds);
  const controller = new globals.AbortController!();
  const schedule = globals.setTimeout ?? setTimeout;
  schedule(
    () => controller.abort(exception(globals, "TimeoutError", "The operation timed out")),
    milliseconds,
  );
  return controller.signal;
}

function validateDelay(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError("AbortSignal timeout must be a finite non-negative number");
  }
}

function exception(globals: AbortGlobalTarget, name: string, message: string): unknown {
  if (globals.DOMException) return new globals.DOMException(message, name);
  const error = new Error(message);
  error.name = name;
  return error;
}
