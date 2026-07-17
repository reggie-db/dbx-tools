# @dbx-tools/demo-appkit-app

The browser half of the demo Databricks App: a React/Vite client whose only real
content is dropping in `<MastraChat/>`.

## What it wires

- [`@dbx-tools/ui-mastra/react`](../../../workspaces/ui/mastra) — `MastraChat`
  drives the whole conversation (streaming, tool-session pills, approval cards,
  model picker, history pagination, chat export, and the thread switcher) by
  wiring itself from the Mastra plugin's published client config. No transport
  code lives here.
- [`@dbx-tools/ui-appkit`](../../../workspaces/ui/appkit) — the AppKit UI kit
  re-export (`/react`) plus the shared Tailwind/Vite setup (`/vite`).

## Pages

- `src/pages/Stream.tsx` — `<MastraChat showModelPicker enableExport />`.
- `src/pages/Conversations.tsx` — the same component with its thread sidebar,
  showing multi-conversation storage.

## Build

The `app` tag generates `vite.config.ts`; `vite.config.override.js` layers in
Tailwind v4 (`@tailwindcss/vite`) and the `@` → `src` alias. `src/index.css`
`@import`s the AppKit + feature UI stylesheets, so there's no separate Tailwind
CLI step.

```bash
pnpm dev       # vite dev server
pnpm build     # vite build -> dist/ (served by the server package)
```

See the [demo README](../../README.md) for full setup.
