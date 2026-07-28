import type { ThreadSummary } from "../react/types.ts";

// Display formatting for a conversation row, shared by the two surfaces that
// list threads (`ThreadSidebar` and `ThreadTabs`) so a sidebar row and a tab
// never disagree about what an untitled or freshly-updated thread reads as.

/** Title for a thread, falling back to a placeholder when unnamed. */
export function threadTitle(thread: ThreadSummary): string {
  const title = thread.title?.trim();
  return title && title.length > 0 ? title : "New conversation";
}

/**
 * Render an ISO-8601 timestamp as a coarse "time ago" hint
 * (`just now`, `5m ago`, `3h ago`, `2d ago`, or a locale date for
 * anything older than a week). Invalid input renders nothing.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
