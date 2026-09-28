# Bug: Empty Mastra composer remains at maximum height after opening

- Reported / reproduced: 2026-09-28.
- Status: resolved and archived 2026-09-28.
- Owning package: `@dbx-tools/ui-mastra`.
- Fix plan: [composer autosizing](../enhancements/2026-09-28-mastra-composer-autosizing.md).
- Source: user screenshot from Flow Studio and an independent local browser
  reproduction. No chat message was submitted.

## Reproduction and expected behavior

1. Open a fresh Flow Studio page at `http://localhost:8765/workflows` with the
   assistant initially collapsed. The observed viewport was 1280 x 720.
2. Select **Open workflow assistant** and leave its draft empty.
3. Inspect the textarea: it renders at 192px with a stale inline height of 432px.
4. Type `x`, then remove it. It now renders at 64px with a 64px inline height.

Expected: first opening settles at the same compact empty height as step 4.
Resizing or reopening must recalculate height without requiring a draft edit.

## Diagnosis and ownership

In [ChatComposer](../../../packages/js/ui/mastra/src/react/chat-composer.tsx),
`useLayoutEffect` resets height to `auto`, measures `scrollHeight`, and stores it
as an inline height, but reruns only when `input` changes. The CSS maximum is
`max-h-48`, which clamps the stale measurement to 192px. AppKit also provides
`field-sizing-content` and `min-h-16` through `InputGroupTextarea`.

Flow Studio mounts the chat while its resizable panel begins collapsed, then
expands the panel in a parent effect. Measurement before expansion is the likely
trigger; the precise width during that first measurement was not captured. The
stale inline height and recovery after editing were directly observed.

The sizing effect and classes are identical in dbx-tools `0.6.217` and Flow
Studio's vendored `0.6.216` composer. Flow Studio has no textarea height override.
The fix belongs in the shared component; preserve the host's panel behavior.

## Resolution

`ChatComposer` now owns fixed textarea sizing through one measurement callback.
It remeasures on input and history-placeholder changes and observes the
`InputGroup` width, ignoring zero and unchanged widths so opening a collapsed
panel cannot preserve a stale height or create a ResizeObserver loop.

Chromium verification with the actual `ChatView` and AppKit styles passed at
320px, 480px, and 800px host widths. A zero-width mount expanded to the 64px
empty baseline without input. Multiline content capped at 192px with internal
scrolling, widening shrank the draft, repeated collapse/reopen cycles were
stable, and history, Enter/Shift+Enter, send, stop, deletion, and clearing
preserved behavior. No console or ResizeObserver errors occurred. Package
compile and all 47 `ui-mastra` tests passed.

Flow Studio still needs a separately scoped dependency refresh to consume this
released upstream fix.
