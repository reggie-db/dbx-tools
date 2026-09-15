# @dbx-tools/demo-appkit-app

The browser half of the demo Databricks App: a Bun-built React client that
dogfoods the repository's AppKit-oriented chat, search, Teams, authentication,
branding, email, and Postgres topic-bus UI packages.

## What it wires

- [`@dbx-tools/ui-mastra/react`](../../../js/ui/mastra) — `MastraChat`
  drives the whole conversation (streaming, tool-session pills, approval cards,
  model picker, history pagination, chat export, and the thread switcher) by
  wiring itself from the Mastra plugin's published client config. No transport
  code lives here.
- [`@dbx-tools/ui-search/react`](../../../js/ui/search) — native AppKit AI
  Search and the Lakebase full-text fallback share one search box and result
  surface.
- [`@dbx-tools/ui-teams/react`](../../../js/ui/teams) — live Adaptive Card
  rendering plus the Teams-shaped synchronous and Bot Framework chat paths.
- [`@dbx-tools/ui-auth/react`](../../../js/ui/auth) — the passkey-first gate,
  authentication status, and logout surface used by the public tunnel.
- [`@dbx-tools/ui-branding/react`](../../../js/ui/branding) and
  [`@dbx-tools/ui-email/react`](../../../js/ui/email) — one active brand context
  drives the shell and outbound-email previews.
- [`@dbx-tools/ui-appkit`](../../../js/ui/appkit) — the AppKit UI kit
  re-export (`/react`) plus the shared Tailwind foundation.

## Pages

- `src/pages/Stream.tsx` — `<MastraChat showModelPicker enableExport />`.
- `src/pages/Conversations.tsx` — the same component with its thread sidebar,
  showing multi-conversation storage.
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
