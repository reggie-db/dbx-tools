# @dbx-tools/ui-appkit

Shared React and Tailwind foundation for AppKit-oriented UI packages.

Import this package when a React client or feature UI package needs the same
base stylesheet and component imports used by dbx-tools AppKit UI components.
It centralizes Tailwind v4, Streamdown base styles, and a shiki token paint shim
for streamed markdown/code output.

Key features:

- Stable `@dbx-tools/ui-appkit/react` re-export of AppKit's React component
  primitives for feature packages.
- `BrandPicker`, a controlled AppKit-native editor for portable identity,
  color tokens, document metadata, and assets.
- AppKit UI stylesheet import path for host applications and feature packages.
- Streamdown/code-block styling used by streaming chat and Markdown surfaces.
- One place to evolve UI styling assumptions for feature packages such as
  [`@dbx-tools/ui-email`](../email) and [`@dbx-tools/ui-mastra`](../mastra).

## Why Not Just AppKit UI?

Use `@databricks/appkit-ui` directly in app code when you only need AppKit's
components and hooks. This package exists for dbx-tools feature packages and
hosts that want one stable import path for AppKit primitives,
Streamdown/shiki styling, and Tailwind source registration. Host applications
remain responsible for their own Bun, Vite, or other build configuration.

## Import Styles

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-appkit/styles.css";
```

The stylesheet imports Tailwind and Streamdown styles, then adds the shiki CSS
variable shim used by Streamdown code-block spans. Feature UI packages should
import this once and add their own `@source` directives for local class names.

## Edit A Live Brand

`BrandPicker` emits only complete, schema-valid `BrandContext` values. Feed the
result back into `BrandProvider` to update AppKit tokens, document metadata,
brand assets, and brand-aware feature UI together.

```tsx
import { brand } from "@dbx-tools/shared-core";
import { BrandPicker } from "@dbx-tools/ui-appkit/react";
import { BrandProvider } from "@dbx-tools/ui-branding/react";
import { useState } from "react";

export function BrandSettings() {
  const [context, setContext] = useState(brand.defaultBrandContext);
  return (
    <BrandProvider context={context} applyToDocument>
      <BrandPicker value={context} onChange={setContext} />
    </BrandProvider>
  );
}
```

## Build Feature UI Packages

Feature packages should depend on this package instead of each owning their own
Tailwind and Streamdown base setup. That gives downstream host apps one place to
look for:

- shared markdown/code styling;
- AppKit UI peer assumptions;
- future shared React utilities.

## Module

- `./react` - AppKit React UI kit re-export plus the controlled `BrandPicker`.
- `./styles.css` - Tailwind/Streamdown/shiki base stylesheet.

App-specific React components should live in feature UI packages that import this
foundation. Cross-feature AppKit utilities such as `BrandPicker` live here.
