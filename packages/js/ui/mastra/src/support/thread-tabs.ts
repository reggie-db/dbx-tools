import type { ThreadSummary } from "../react/types.ts";

// Which conversations are open as tabs in the `top` thread placement, kept as
// pure functions so the tab strip's bookkeeping is testable without a DOM.
//
// A tab is an OPEN conversation, not the conversation itself: closing a tab
// only takes it off the strip (the thread stays in history and in the list the
// history menu shows), while deleting a thread removes it everywhere. The set
// is session-scoped - the strip reseeds from the most recent conversations on
// the next load - so a reload never resurrects a stale tab for a thread the
// user has since deleted.

/**
 * How many of the most recent conversations the strip opens as tabs the first
 * time the thread list arrives. Sized to fill a typical strip without pushing
 * the active tab off-screen behind horizontal scroll.
 */
export const THREAD_TAB_SEED_MAX = 5;

/**
 * Reconcile the open tabs against the current thread list and selection:
 * drop tabs whose conversation no longer exists, seed from the newest
 * conversations while the strip is empty, and always keep a tab for the active
 * thread (a brand-new one isn't in the server list yet, so it's kept on the
 * strength of being active alone).
 *
 * Returns `openIds` itself when nothing changed, so a caller can drive this
 * from an effect without looping on a fresh array every render.
 */
export function syncThreadTabs(
  openIds: string[],
  threads: ThreadSummary[],
  activeThreadId?: string,
  seedMax: number = THREAD_TAB_SEED_MAX,
): string[] {
  const known = new Set(threads.map((thread) => thread.id));
  let next = openIds.filter((id) => known.has(id) || id === activeThreadId);
  if (next.length === 0) next = threads.slice(0, seedMax).map((thread) => thread.id);
  if (activeThreadId && !next.includes(activeThreadId)) next = [...next, activeThreadId];
  const unchanged = next.length === openIds.length && next.every((id, i) => id === openIds[i]);
  return unchanged ? openIds : next;
}

/** Take a conversation off the strip, leaving the rest in order. */
export function closeThreadTab(openIds: string[], id: string): string[] {
  return openIds.filter((tab) => tab !== id);
}

/**
 * Which tab to activate after closing `id`: the one to its right, else its
 * left neighbour, else `undefined` when it was the only tab open (the caller
 * then starts a fresh conversation rather than leaving nothing selected).
 */
export function nextActiveThreadTab(openIds: string[], id: string): string | undefined {
  const index = openIds.indexOf(id);
  if (index === -1) return undefined;
  if (index + 1 < openIds.length) return openIds[index + 1];
  if (index > 0) return openIds[index - 1];
  return undefined;
}
