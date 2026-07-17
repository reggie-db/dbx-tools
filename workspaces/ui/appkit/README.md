# @dbx-tools/ui-appkit

Shared React/Vite/Tailwind foundation for AppKit-oriented UI packages.

Import this package when a React client or feature UI package needs the same
Vite plugin setup and base stylesheet used by dbx-tools AppKit UI components.
It centralizes React refresh, Tailwind v4, Streamdown base styles, and a shiki
token paint shim for streamed markdown/code output.

Key features:

- Shared Vite plugin factory for React and Tailwind v4.
- Stable `@dbx-tools/ui-appkit/react` re-export of AppKit's React component
  primitives for feature packages.
- AppKit UI stylesheet import path for host applications and feature packages.
- Streamdown/code-block styling used by streaming chat and Markdown surfaces.
- One place to evolve UI build assumptions for feature packages such as
  [`@dbx-tools/ui-email`](../email) and [`@dbx-tools/ui-mastra`](../mastra).

## Why Not Just AppKit UI?

Use `@databricks/appkit-ui` directly in app code when you only need AppKit's
components and hooks. This package exists for dbx-tools feature packages and
hosts that want one stable import path for AppKit primitives, React/Tailwind Vite
setup, Streamdown/shiki styling, and Tailwind source registration.

## Configure Vite

```ts
import { appkitUiVitePlugins } from "@dbx-tools/ui-appkit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: appkitUiVitePlugins(),
});
```

`vite.appkitUiVitePlugins()` returns the React plugin and Tailwind v4 plugin.
Using it keeps host applications and feature packages on the same Vite/Tailwind
integration.

## Import Styles

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-appkit/styles.css";
```

The stylesheet imports Tailwind and Streamdown styles, then adds the shiki CSS
variable shim used by Streamdown code-block spans. Feature UI packages should
import this once and add their own `@source` directives for local class names.

## Build Feature UI Packages

Feature packages should depend on this package instead of each owning their own
Tailwind and Streamdown base setup. That gives downstream host apps one place to
look for:

- Vite plugin defaults;
- shared markdown/code styling;
- AppKit UI peer assumptions;
- future shared React utilities.

## Module

- `./vite` - `appkitUiVitePlugins()` for React + Tailwind v4 Vite projects.
- `./react` - AppKit React UI kit re-export for feature packages and hosts.
- `./styles.css` - Tailwind/Streamdown/shiki base stylesheet.

App-specific React components should live in feature UI packages that import this
foundation.
