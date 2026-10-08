# Preserve explicitly closed Mastra thread tabs

Date: 2026-10-08

Status: Proposed

## Problem

`@dbx-tools/ui-mastra` reseeds the top thread strip from recent history whenever
the open-tab array becomes empty. A user who closes every active tab sees old
conversation tabs immediately reappear.

The issue is in `syncThreadTabs()`:

```ts
if (next.length === 0) {
  next = threads.slice(0, seedMax).map((thread) => thread.id);
}
```

The function cannot distinguish the initial unseeded state from an explicitly
empty state created by the user.

## Expected behavior

- Seed recent conversations only when the thread layout initializes.
- Closing a tab keeps that conversation in history without reopening it.
- Closing the final active tab starts one fresh conversation.
- Loading or refreshing the thread list does not resurrect explicitly closed
  tabs during the current mounted session.
- A full remount may seed recent conversations again, preserving the documented
  session-scoped behavior.

## Implementation

Represent uninitialized tabs separately from an initialized empty list in
`chat-thread-layout.tsx`, for example with `string[] | null`.

1. Seed from recent threads only while state is `null`.
2. Reconcile initialized arrays by removing deleted thread IDs and adding the
   active thread, without seeding because the array is empty.
3. Keep `closeThreadTab()` and `nextActiveThreadTab()` pure.
4. When the final active tab closes, call `onNewThread()` and allow only that
   new active thread to enter the strip.

Update `syncThreadTabs()` to receive an explicit initialization or seeding
decision instead of inferring it from `openIds.length`.

## Tests

Add coverage for:

- initial state seeds at most `THREAD_TAB_SEED_MAX` recent conversations;
- an explicitly empty initialized list remains empty;
- closing all inactive tabs does not reopen them;
- closing the final active tab opens only the fresh conversation;
- thread refresh and pagination do not resurrect closed tabs;
- deleting an open thread still removes it from the strip.

## Consumer workaround

Until a release includes this change, applications can use a fixed left or
right conversation drawer instead of top or automatic tab placement.
