# Persistent Mastra assistant host and typed turn context

Status: completed and archived 2026-09-29.

## Goal

Consolidate the floating launcher and slide-out assistant shells repeated by
LensIQ, Creative IQ, and Passenger IQ into `@dbx-tools/ui-mastra`. The shared
surface must remain mounted across route navigation, support docked and overlay
panels on every edge, optionally resize, accept custom launch/header content,
and open from any descendant control with typed application request context.

The same change keeps complete tool request/result payloads available in
expandable chat pills and reshapes the composer after ChatGPT: growing textarea
above a fixed footer, inline model selector, and Send/Stop pinned bottom-right.

## Constraints

- Keep the surface in `@dbx-tools/ui-mastra`; no new package or dependency.
- Compose AppKit UI primitives and existing `useMastraChat` / `ChatView`.
- Mount inside the host's existing authentication gate and above its route
  outlet. Authentication stays host-owned.
- Application context cannot override trusted AppKit/Mastra identity, resource,
  thread, auth, scope, model, or trace fields.
- Use Mastra's native generic `RequestContext<T>` and `requestContextSchema`.
- Never truncate raw tool call input or result data.

## Native Mastra audit

The implementation was rechecked against the installed package declarations and
runtime after upgrading to the newest coherent set available from the local
mirror: core 1.71.0, client-js 1.50.0, server 1.70.0 through Express 1.5.14,
MCP 2.1.0, memory 1.32.1, and Postgres 1.27.1.

- Normal turns use native `MastraClient`, `ChunkType`, `processDataStream`, and
  persisted AI SDK tool parts. The handwritten shared stream schema/parser and
  output-result processor were deleted.
- Application context uses native `RequestContext<T>` and
  `requestContextSchema`; dbx-tools only snapshots JSON values for concurrent
  queue/run isolation and applies AppKit's trusted identity policy.
- Native AI SDK tool-part guards own persisted request/result reconstruction.
- The persistent assistant, multi-thread queue, AppKit routes, and trusted
  context stamps remain product-specific behavior not provided by installed
  Mastra packages.
- One compatibility seam remains on approval routes only. Client-js 1.50 still
  logs `tool_result must be preceded by a tool_call` when a valid resumed stream
  begins with the pending `tool-result`. `_approval-stream.ts` reads that route
  into native `ChunkType` without the client's chat-state side channel. A
  focused regression pins removal once upstream accepts the shape.

## Acceptance

- Floating launcher supports all four corners and custom icon/content.
- Panel supports `dock` and `overlay`, every edge, controlled/uncontrolled open
  state, optional resize, optional size persistence, and mobile overlay fallback.
- Header is optional with replaceable assistant, launcher, new, history, and
  close icons. When enabled it owns New/History/Close and leaves conversation
  pills on a second row; without it those controls stay beside the pills.
- A descendant button can call `open(context)` without remounting the chat.
- Route navigation preserves draft, thread, panel, active stream, and context.
- Top thread tabs expose assistant close beside conversation history.
- Request context is isolated per concurrent run, queued steer, regeneration,
  and approval continuation.
- Agent schemas validate typed application context before model execution.
- Tool pills show complete default-closed Request and Response payloads.
- Approval-gated email exposes Mastra's native conditional `requireApproval`
  callback for classifier or durable prior-decision policies; no client-side
  approval memory is invented.
- Composer grows to its cap, then scrolls while the footer remains fixed.
- The example app dogfoods the host and remains running for browser validation.

## Validation

- All JavaScript workspace packages compile and test successfully.
- `ui-mastra` passes 57 focused tests; `appkit-mastra` passes 121.
- Browser fixtures passed dock/overlay on every edge, four launcher corners,
  custom icons, optional headers, pointer/keyboard resizing, stored size, mobile
  fallback, route-stable drafts/streams, concurrent context isolation, approval
  continuation, and complete large tool payloads.
- Composer measurements passed at narrow width: 64px single-line, 168px
  six-line, 256px capped multiline with internal scrolling and no footer overlap.
- The live demo preserved a draft while navigating between `/chat` and `/cards`.
- Live resize accessibility reports 360/1003/480 min/max/current values; model
  selector has an accessible name and tab-close target is 24x24 CSS pixels.
- Lighthouse on the live assistant passes all 32 checks with Accessibility,
  Best Practices, and SEO scores of 100.
- The focused demo runs on `http://127.0.0.1:8000` with optional Graphiti, bus,
  and remote skills disabled and email using the local outbox.
