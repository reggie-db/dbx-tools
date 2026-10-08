# @dbx-tools/ui

Use one tree-shakeable React package for the shared AppKit UI foundation,
branding, passwordless authentication, email surfaces, and AI Search controls.
Mastra chat and Teams Adaptive Cards remain separate packages because they have
larger optional dependency families.

## Foundation

```tsx
import { Button, BrandPicker } from "@dbx-tools/ui/react";
import "@dbx-tools/ui/styles.css";
```

`./react` re-exports the tested AppKit UI primitives and adds `BrandPicker`.
`./styles.css` provides Tailwind, Streamdown, code-block, and brand-token bridge
styles for dbx-tools feature UI.

## Branding

```tsx
import { BrandProvider, BrandLogo } from "@dbx-tools/ui/branding/react";
import { applyBrandContext } from "@dbx-tools/ui/branding/browser";
import { dbxToolsAssetDataUrls } from "@dbx-tools/ui/branding/assets";
```

Import `@dbx-tools/ui/branding/styles.css` for default brand variables. Static
SVG assets are exported under `@dbx-tools/ui/branding/assets/*`.

## Authentication

```tsx
import { AuthGate, PasskeyManager } from "@dbx-tools/ui/auth/react";
```

These components consume the browser-safe `@dbx-tools/shared-auth` contracts and
the routes provided by `@dbx-tools/auth-gate`.

## Email

```tsx
import { EmailApprovalCard, EmailComposeView } from "@dbx-tools/ui/email/react";
import "@dbx-tools/ui/email/styles.css";
```

Email components consume `@dbx-tools/shared-email` and
`@dbx-tools/shared-email-template`; they do not own transport or approval policy.

## Search

```tsx
import { SearchBox, SearchResults, useSearch } from "@dbx-tools/ui/search/react";
import "@dbx-tools/ui/search/styles.css";
```

Search components consume `@dbx-tools/shared-search` and AppKit's browser query
hook. Backend selection remains in `@dbx-tools/search`.

## Export Map

- `./react`, `./styles.css` - common AppKit UI foundation.
- `./branding/react`, `./branding/browser`, `./branding/assets` - brand runtime and assets.
- `./auth/react` - passwordless sign-in and passkey management.
- `./email/react`, `./email/styles.css` - approval, preview, and compose UI.
- `./search/react`, `./search/styles.css` - AI Search controls and state.
