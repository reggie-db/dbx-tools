/** Root task and CLI defaults for the generic development command watcher. */

/** Projen task exposed as `bun run dev:watch`. */
export const DEV_WATCH_TASK = "dev:watch";
/** Shipped task entrypoint invoked by {@link DEV_WATCH_TASK}. */
export const DEV_WATCH_SCRIPT = "dev-watch.ts";
/** Quiet period after the last watched change before restarting. */
export const DEV_RESTART_DEBOUNCE_MS = 15_000;
/** Interactive key that requests an immediate restart. */
export const DEV_RESTART_KEY = "r";
