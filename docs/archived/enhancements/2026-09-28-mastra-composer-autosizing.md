# Enhancement: Size the Mastra composer after its container opens or resizes

## Tracking

- Created / updated: 2026-09-28.
- Status: completed and archived 2026-09-28.
- Coordinator: Codex, Flow Studio chat-input investigation.
- Mode: implemented and browser-verified.
- Request: determine whether Flow Studio's oversized empty chat input belongs
  to this library or the host, and write a fix plan in the owning repository.
- Owner: `@dbx-tools/ui-mastra`, specifically `ChatComposer`.
- Related defect: [oversized empty composer](../bugs/2026-09-28-mastra-composer-autosizing.md).
- Baseline inspected around 2026-09-28 20:59 UTC: dbx-tools commit
  `a5cb831edd029b61704715ab22a1e643d399fa03`, package version `0.6.217`;
  Flow Studio commit `27db5a17c42681c3f7df55c7b5580f8f326b5b1e`, vendored
  `@dbx-tools/ui-mastra` version `0.6.216`.
- Both checkouts contain other work. Existing dbx-tools edits cover `AGENTS.md`,
  the demo Brand page, shared-core brand tests, and ui-branding source/docs/tests.
  Flow Studio has active client, server, dependency, and development-script edits.
  Their owners are unconfirmed; this investigation reserves no source paths.
- This planning session owns only this plan, its linked defect, and their two
  `docs/enhancements/README.md` / `docs/bugs/README.md` index entries.

## Problem and ownership

Opening Flow Studio's workflow assistant can show an empty input at its maximum
height. It consumes transcript space and leaves the send button floating in a
large blank box. Typing a character and deleting it restores the smaller height.

Fix the shared composer in dbx-tools. Flow Studio supplies a legitimate
collapsible, resizable container, while `ChatComposer` owns the inline textarea
height. The same sizing code is present upstream and in the vendored snapshot.
No host-specific height override or change to the AppKit textarea primitive is
needed in the proposed scope.

## Evidence and constraints

Observations below were rechecked against current files and the running local
Flow Studio app on 2026-09-28. The screenshot supplied by the user is symptom
evidence; the measurements came from a separate browser reproduction.

| Finding                                                                                                                                                                                                                                 | Source                                                                                                                                        | Confidence / implication                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The composer sets `height = "auto"`, then copies `scrollHeight` into an inline height in an effect depending only on `input`.                                                                                                           | [chat-composer.tsx](../../../packages/js/ui/mastra/src/react/chat-composer.tsx), lines 283-288                                                | Verified. Container resize and placeholder/history changes do not trigger this measurement.                                                   |
| `rows={1}` is combined with `max-h-48`. The AppKit primitive supplies `field-sizing-content` and `min-h-16`.                                                                                                                            | Same composer, plus installed `@databricks/appkit-ui/dist/react/ui/{input-group,textarea}.js` and `.d.ts`                                     | Verified. Native content sizing and an explicit JavaScript height coexist; the CSS maximum hides the size of a stale measurement.             |
| Freshly opening the assistant produced an empty textarea with inline height `432px`, rendered height `192px`, and computed min/max heights `64px` / `192px`. Typing `x`, then deleting it, produced `64px` inline and rendered heights. | `http://localhost:8765/workflows`, fresh browser tab at 1280 x 720; no message sent                                                           | Verified. This is stale measured height, not an intentionally large empty state.                                                              |
| Flow Studio activates `MastraChat` while its panel starts collapsed (`defaultSize={0}`, `collapsedSize={0}`); a parent effect calls `expand()`.                                                                                         | Flow Studio `client/src/components/AppShell.tsx`, lines 57-60 and 131-144; `client/src/components/AssistantPanel.tsx`, lines 35-45            | Verified lifecycle. Measuring before expansion is the likely trigger; the width at the exact measurement instant was not captured.            |
| The upstream and vendored composer differ only in input/select IDs and names.                                                                                                                                                           | Diff of upstream `packages/js/ui/mastra/src/react/chat-composer.tsx` and Flow Studio `vendor/dbx-tools/ui-mastra/src/react/chat-composer.tsx` | Verified. Those differences do not change the sizing effect.                                                                                  |
| Flow Studio imports the shared styles and does not apply a textarea height override.                                                                                                                                                    | Flow Studio `client/src/index.css`, `client/src/branding/brand.css`, and `AssistantPanel.tsx`                                                 | Verified. Local `font: inherit` affects typography, but does not explain the unchanged text becoming three times shorter after remeasurement. |

AppKit documentation was inspected with `bunx --no-install @databricks/appkit
docs`, alongside installed declarations. Continue using `InputGroup`,
`InputGroupTextarea`, `InputGroupAddon`, and `InputGroupButton`; do not duplicate
these primitives. Public `ChatView` / `MastraChat` props, transport, credentials,
history, and backend execution remain outside the change.

## Scope and design

Make the existing JavaScript autosizing respond to the available width as well
as draft content, with one owner for height:

1. Keep the sizing logic local to `ChatComposer`. Set the textarea to fixed
   field sizing while JavaScript owns height, avoiding competing native and
   inline sizing. Verify that the installed Tailwind emits the chosen utility.
2. Reuse one measurement function for initial layout, input edits/reset,
   history-loading placeholder changes, and container-width changes. Reset
   height before reading `scrollHeight`, so deletion and widening also shrink it.
3. Observe the input group's available width with `ResizeObserver`. Recalculate
   after a collapsed/hidden container becomes measurable. Ignore unusable
   measurements, and compare widths so height writes do not create observer
   loops. Clean up the observer on unmount. Preserve input-based measurement if
   the observer is unavailable.
4. Preserve the current `min-h-16` empty baseline and `max-h-48` growth cap
   (64px and 192px at the observed 16px root size), with internal scrolling for
   longer drafts. Do not hard-code theme-specific pixel values as new CSS.
5. Preserve send/stop placement, Enter versus Shift+Enter behavior, queued
   steers, model selection, export, and clear controls. Keep draft state intact
   across panel visibility and size changes.

The task is a layout correction, not a chat redesign. Toolbar overflow at very
narrow widths, host typography, and a smaller-than-64px empty composer are
separate issues. Do not change dependency manifests, generated output, global
AppKit styles, or Flow Studio's vendored source as part of this plan.

## Acceptance criteria

- [x] Fresh mount in a visible container and first opening from zero width both
      settle at the same compact empty height without typing or focusing.
- [x] At a 16px root size, the empty input returns to the current 64px baseline
      rather than remaining at 192px; theme-relative sizing is preserved.
- [x] Closing/reopening, widening/narrowing the container, and toggling history
      loading recompute height without losing the draft or requiring an edit.
- [x] Multiline drafts grow to the existing cap and scroll internally; removing
      lines, clearing the draft after a fixture send, and widening shrink them.
- [x] Send/stop, Enter/Shift+Enter, and adjacent actions remain usable, with no
      ResizeObserver loop warnings or repeated growth after repeated openings.
- [x] Before/after browser measurements are recorded for a resizable embed and
      a normal-width chat; package compile/tests pass.

## Tasks and ownership

One implementation owner is sufficient.

| ID  | Deliverable / completion condition                                                                         | Owner                  | Exact write paths                                                                                                              | Depends on                                  | Status |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------ |
| T1  | Implement width-aware autosizing; fresh-open reproduction settles compactly and draft growth/shrink works. | `@dbx-tools/ui-mastra` | `packages/js/ui/mastra/src/react/chat-composer.tsx` and `_composer-autosize.ts`                                                | Implementation request and source ownership | `done` |
| T2  | Verify the browser matrix below and package checks; record measured results and any remaining defects.     | `@dbx-tools/ui-mastra` | `packages/js/ui/mastra/test/composer-autosize.test.ts`; this plan; the linked bug record                                       | T1                                          | `done` |
| T3  | Close and archive both records after all criteria pass; repair index links.                                | `@dbx-tools/ui-mastra` | Both active records and indexes; corresponding paths and indexes under `docs/archived/enhancements/` and `docs/archived/bugs/` | T2                                          | `done` |

## Validation

An isolated, temporary controlled `ChatView` fixture with stub callbacks tested
send/reset/streaming states without model requests. It included visible and
zero-width-first containers, used the actual AppKit and ui-mastra CSS, and
exercised 320px, 480px, and 800px host widths, repeated collapse/expand, empty
and multiline drafts, deletion, and history-placeholder transitions.

| Check                                                              | Actual result                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Live Flow Studio reproduction, then type/delete without submission | Reproduced: empty inline/rendered heights `432px` / `192px`; after edit/delete `64px` / `64px`. |
| Upstream versus vendored sizing comparison                         | Same effect and sizing classes; only input/select identity attributes differ.                   |
| Installed AppKit docs/declarations                                 | Inspected; native textarea sizing and group composition confirmed.                              |
| Planning-document formatting and links                             | Passed: Prettier, local links, and `git diff --check` (2026-09-28).                             |
| Package compile/tests and fixed-behavior browser matrix            | Passed: compile, 47 tests, and Chromium checks at 320px, 480px, and 800px.                      |
| Autosize regression coverage                                       | Pins zero-width recovery, width deduplication, remeasurement, fallback, and observer cleanup.   |
| Empty and collapsed-first composer                                 | `64px` visible; zero-width mount reopened to `64px` without editing.                            |
| Multiline growth and width changes                                 | Capped at `192px`; widening from 320px to 800px shrank `384px` inline height to `124px`.        |
| Repeated lifecycle and diagnostics                                 | Four collapse/reopen cycles passed with no console or ResizeObserver errors.                    |

## Handoff and downstream adoption

The shared fix is complete. `ChatComposer` uses fixed field sizing, one
reset-and-measure callback, and a width-only `ResizeObserver` guard. The
controlled browser fixture confirmed the zero-width trigger and all acceptance
states without model requests.

Flow Studio pins a vendored snapshot; an upstream fix will not update it
automatically. After the library fix is validated and available, plan a scoped
dependency refresh in Flow Studio, reconcile its existing vendor edits, and run
its own `bun run verify` plus the first-open browser reproduction. That
dependency refresh, deployment, and cross-repository source change remain
separate from this upstream release.

The remaining work is downstream only: Flow Studio must refresh its vendored
`@dbx-tools/ui-mastra` snapshot to a release containing this change and run its
own first-open reproduction.
