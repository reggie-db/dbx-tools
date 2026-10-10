# @dbx-tools/demo-appkit-app

The browser half of the demo Databricks App: a Bun-built React client that
dogfoods the repository's AppKit-oriented chat, search, Teams, authentication,
branding, email, and Postgres topic-bus UI packages.

## Quick Start

Wrap the routed application once to keep chat state alive across page changes:

```tsx
import { MastraAssistant } from "@dbx-tools/ui-mastra/react";

export function App() {
  return (
    <MastraAssistant mode="overlay" side="right" chat={{ showModelPicker: true }}>
      <AuthenticatedRoutes />
    </MastraAssistant>
  );
}
```

## What it wires

- [`@dbx-tools/ui-mastra/react`](../../../js/ui/mastra) — `MastraAssistant`
  wraps the authenticated routed app with a resizable persistent overlay,
  floating and navigation launchers, route-aware typed request context, and a
  chat that stays mounted while pages change. `MastraChat` drives the focused
  Chat page. Tool pills preserve expandable raw request/results. The Chat page
  starts with Genie Agent Mode enabled and
  places a checkbox beside the inline model selector that switches to an
  otherwise-identical polling agent.
- [`@dbx-tools/ui/search/react`](../../../js/ui/appkit) — native AppKit AI
  Search and the Lakebase full-text fallback share one search box and result
  surface.
- [`@dbx-tools/ui-teams/react`](../../../js/ui/teams) — live Adaptive Card
  rendering plus the Teams-shaped synchronous and Bot Framework chat paths.
- [`@dbx-tools/ui/auth/react`](../../../js/ui/appkit) — the passkey-first gate,
  authentication status, and right-aligned logout surface used by the public
  tunnel. Logout is omitted when tunnel authentication is unavailable.
- [`@dbx-tools/ui/branding/react`](../../../js/ui/appkit) and
  [`@dbx-tools/ui/email/react`](../../../js/ui/appkit) — one active brand context
  drives the shell and outbound-email previews.
- [`@dbx-tools/ui`](../../../js/ui/appkit) — the AppKit UI kit
  re-export (`/react`) plus the shared Tailwind foundation.

## Pages

- `src/pages/Chat.tsx` - the single focused chat page, with a
  default-on Agent Mode checkbox in
  `<MastraChat composerActions>`, beside the model selector. It selects
  `support` for Agent Mode SSE or `support-polling` for Conversation API
  polling.
- `src/pages/Brand.tsx` — a live `BrandPicker` that updates the whole site plus
  rich email previews that inherit the active brand, with one intentionally
  independent campaign identity.
- `src/pages/Search.tsx` — one UI over native Vector Search or the AppKit-shaped
  Lakebase full-text provider, plus universal search across configured indexes.
- `src/pages/Cards.tsx` — Adaptive Card galleries and a Teams protocol chat that
  exercises the same Mastra agent used by the streaming page.
- `src/pages/Bus.tsx` — the Postgres topic bus. Publish a `type`/`metadata`/`body`
  envelope and watch it arrive in every open viewer over an SSE stream, tagged
  `you` or `other`. Open it in two tabs (the second one first — delivery is live,
  not replayed) to see the fan-out.

## Build

The `app` tag generates Bun build and development entry points. The production
build uses `Bun.build` with `bun-plugin-tailwind`; the development server uses
`Bun.serve` with HMR. `bun-build.override.ts` pins every React import to the
application's copy so source-linked UI packages cannot create a second hooks
runtime. `src/index.css` imports the AppKit and feature stylesheets directly.

```bash
bun run dev       # Bun development server with HMR
bun run compile   # Bun production build -> dist/
```

See the [demo README](../../README.md) for full setup.
