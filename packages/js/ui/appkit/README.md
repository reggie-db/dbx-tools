# @dbx-tools/ui

Use this React package for the shared Databricks AppKit UI foundation, branding,
passwordless authentication, email surfaces, and Databricks AI Search controls.
Import only the subpaths that your browser application uses.

## Foundation

```tsx
import { Button, BrandPicker } from "@dbx-tools/ui/react";
import "@dbx-tools/ui/styles.css";
```

`./react` re-exports Databricks AppKit UI primitives and adds `BrandPicker`.
`./styles.css` provides Tailwind, Streamdown, code-block, and brand-token bridge
styles for dbx-tools UI packages.

## Choose a UI package

- Use `@dbx-tools/ui` for common AppKit components, branding, authentication,
  email, and search. Import its base stylesheet and any feature stylesheet.
  Authentication components call [@dbx-tools/auth-gate](../../node/auth-gate)
  routes. Search components pair with [@dbx-tools/search](../../node/search)
  and use AppKit's published `aiSearch` client configuration.
- Use [@dbx-tools/ui-mastra](../mastra) with
  [@dbx-tools/appkit-mastra](../../node/appkit-mastra). Import the AppKit UI
  stylesheet before the Mastra stylesheet. Mount chat inside the application's
  authentication boundary. The client reads the plugin's published
  `clientConfig()` payload.
- Use [@dbx-tools/ui-teams](../teams) with
  [@dbx-tools/teams](../../node/teams). Import the AppKit UI stylesheet before
  the Teams stylesheet. The preview components use explicit HTTP endpoints and
  don't consume published plugin client configuration. Microsoft Teams bot
  authentication remains a server concern.

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
the routes provided by `@dbx-tools/auth-gate`. Set `passkeyNamePrefix` on either
component to override the server-provided prefix used before the humanized tunnel
subdomain.

## Email

```tsx
import { EmailApprovalCard, EmailComposeView } from "@dbx-tools/ui/email/react";
import "@dbx-tools/ui/email/styles.css";
```

Email components consume `@dbx-tools/shared-email` and
`@dbx-tools/shared-email-template`. Transport and approval remain server concerns.

## Search

```tsx
import { SearchBox, SearchResults, useSearch } from "@dbx-tools/ui/search/react";
import "@dbx-tools/ui/search/styles.css";
```

Search components consume
[@dbx-tools/shared-search](../../shared/search) and AppKit's browser query
hook. Backend selection and workspace access remain in
[@dbx-tools/search](../../node/search).

## Package exports

- `./react`, `./styles.css`: common AppKit UI foundation.
- `./branding/react`, `./branding/browser`, `./branding/assets`: brand runtime and assets.
- `./auth/react`: passwordless sign-in and passkey management.
- `./email/react`, `./email/styles.css`: approval, preview, and compose UI.
- `./search/react`, `./search/styles.css`: Databricks AI Search controls and state.
