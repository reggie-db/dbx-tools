# @dbx-tools/ui-appkit

Shared UI foundation for `@dbx-tools/*` React feature packages.

## Overview

This package centralizes the Vite and stylesheet pieces used by future AppKit UI
packages. It depends on React, React DOM, `@databricks/appkit-ui`, Tailwind v4,
and Streamdown, but currently exports only build/style helpers rather than
application components.

## Installation

Feature UI packages should depend on this package directly. Host applications
that use the shared Vite helper also need Vite in their toolchain.

```sh
pnpm add @dbx-tools/ui-appkit @databricks/appkit-ui react react-dom
```

## Styles

Import the stylesheet once from the host or feature package stylesheet:

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-appkit/styles.css";
```

The stylesheet imports Tailwind v4 and Streamdown base CSS, then adds the shiki
token paint shim used by Streamdown code renderers.

## Vite

```ts
import { vite } from "@dbx-tools/ui-appkit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: vite.appkitUiVitePlugins(),
});
```

## Modules

- `vite` - `appkitUiVitePlugins()`, returning React refresh and Tailwind v4
  Vite plugins.

This package is the shared foundation for AppKit-oriented UI packages;
feature-specific UI packages remain future work.
