# @dbx-tools/ui-branding

Portable dbx tools brand assets and React/browser bindings for a validated
`BrandContext` from [`@dbx-tools/shared-core`](../../shared/core).

Key features:

- Theme-aware dbx tools icon and logo assets as SVG package exports and data URLs.
- `BrandProvider`, `BrandIcon`, and `BrandLogo` React bindings.
- Framework-agnostic CSS variable and document metadata helpers.
- No duplicated hand-maintained artwork: package assets are generated from the
  root [`branding`](../../../branding) source files.

## React

```tsx
import { BrandIcon, BrandLogo, BrandProvider } from "@dbx-tools/ui-branding/react";

<BrandProvider applyToDocument>
  <BrandIcon width={32} height={32} />
  <BrandLogo width={240} />
</BrandProvider>;
```

Pass parsed YAML/JSON data through `context` to use another brand. Missing
fields receive the dbx tools defaults defined by the shared Zod schema.

## Browser Helpers

```ts
import { applyBrandContext } from "@dbx-tools/ui-branding/browser";
import { brand } from "@dbx-tools/shared-core";

applyBrandContext(brand.parseBrandContext(input));
```

Import `@dbx-tools/ui-branding/styles.css` once to expose the default CSS custom
properties. `applyBrandContext()` updates those properties and can set the page
title and favicon.

## Theming the UI (the `[data-brand]` token bridge)

The dbx-tools UI components style off AppKit's shadcn semantic tokens
(`--primary`, `--ring`, `--sidebar-primary`, `--font-sans`, ...), not the
`--brand-color-*` variables directly. `brand-bridge.css` connects the two: it
remaps those AppKit tokens onto the brand variables, scoped to
`:root[data-brand]`.

It is imported (inert) through `@dbx-tools/ui-appkit/styles.css` — the shared UI
base every feature UI package depends on — so **every dbx-tools UI component
carries the bridge automatically**. It stays inert until a brand is applied:
`applyBrandContext()` (and therefore `<BrandProvider applyToDocument>`) sets the
`data-brand` attribute, which is what activates the remap. With no `data-brand`,
default AppKit renders untouched.

```tsx
// Theme the whole app: sets brand vars + data-brand + title/favicon.
<BrandProvider applyToDocument>
  <App />
</BrandProvider>
```

The bridge is **identity-only** (primary/accent/ring/sidebar-primary + fonts). It
intentionally does not remap neutrals (`--background`/`--foreground`/`--muted`/
`--border`) because a `BrandContext` carries a single light palette — remapping
neutrals would disable dark mode. Add new semantic tokens to re-skin in
`brand-bridge.css`.

## Assets

```ts
import { dbxToolsAssetDataUrls } from "@dbx-tools/ui-branding/assets";
```

Static SVG files are also exported from
`@dbx-tools/ui-branding/assets/icon-light.svg`, `icon-dark.svg`,
`logo-light.svg`, and `logo-dark.svg`.

## Modules

- `./react` - provider, hook, and theme-aware icon/logo components.
- `./browser` - CSS token, metadata, and built-in asset resolution helpers.
- `./assets` - generated SVG strings and data URLs.
- `./assets/*.svg` - static package asset files.
- `./styles.css` - default brand CSS custom properties.
- `./brand-bridge.css` - `:root[data-brand]`-scoped remap of AppKit semantic
  tokens onto the brand variables. Imported via `ui-appkit/styles.css`; inert
  until `applyBrandContext()` sets `data-brand`.
