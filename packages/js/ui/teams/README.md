# @dbx-tools/ui-teams

Render Microsoft Teams Adaptive Cards or a Teams-style conversation preview in
a React application. This browser package uses the
[adaptivecards](https://www.npmjs.com/package/adaptivecards) renderer, card
contracts from [@dbx-tools/shared-teams](../../shared/teams), and the shared
[@dbx-tools/ui](../appkit) foundation.

## Quick start

```tsx
import { TeamsChat } from "@dbx-tools/ui-teams/react";

export function SupportChat() {
  return <TeamsChat className="h-full" />;
}
```

Import the stylesheet after your AppKit UI theme.

## Package fit

Use this package with the [@dbx-tools/teams](../../node/teams) server plugin.
Import `@databricks/appkit-ui/styles.css` before this package's stylesheet. The
components don't read AppKit client configuration. `TeamsChat` and
`AdaptiveCardGallery` use the explicit `endpoint` and `buildEndpoint` props,
which default to `/api/teams/messages` and `/api/teams/card`.

The browser preview doesn't implement Microsoft Bot Framework authentication.
The `/messages` route returns activities in the HTTP response only when the
server enables its development-only `allowUnauthenticated` option. For a local
preview against the normal server configuration, set
`endpoint="/api/teams/activity"`. Keep Microsoft Teams bot credentials and
Connector API delivery on the server.

Use [@dbx-tools/ui-mastra](../mastra) for Mastra chat and
[@dbx-tools/ui](../appkit) for common AppKit, authentication, email, and search
components.

## Package contents

- `TeamsChat` posts Bot Framework activities and renders reply attachments as
  Adaptive Cards. It keeps one conversation ID per mount, cancels an active
  request on unmount, and supports starter prompts.
- `AdaptiveCardView` renders a compiled Adaptive Card and supports
  `Action.OpenUrl` handling through `onOpenUrl`.
- `AdaptiveCardGallery` edits a `CardSpec`, compiles it through
  `POST /api/teams/card`, and renders the result.
- `CARD_SAMPLES` provides examples with facts, link actions, and notes.
- `TextBlock` Markdown uses `marked`. If parsing fails, the renderer displays
  the source as plain text.

## Configure the chat preview

```tsx
import { TeamsChat } from "@dbx-tools/ui-teams/react";

const Chat = () => <TeamsChat className="h-full" />;
```

Point `endpoint` elsewhere if the plugin is mounted under a different name, and
pass `agentId` to converse with a specific agent instead of the server's default.
`starters` replaces the built-in `DEFAULT_STARTERS` prompts.

## Render a card

```tsx
import { AdaptiveCardView, type AdaptiveCard } from "@dbx-tools/ui-teams/react";

const Preview = ({ card }: { card: AdaptiveCard }) => (
  <AdaptiveCardView card={card} className="ac-container" />
);
```

`AdaptiveCardView` renders any compiled Adaptive Card document, including one
returned by the `create_teams_card` tool, the plugin's `buildCard` export, or
the `/api/teams/card` route. Card text is treated as Markdown, matching how
Teams renders a `TextBlock`.

## Add a live preview page

```tsx
import { AdaptiveCardGallery } from "@dbx-tools/ui-teams/react";

const Cards = () => <AdaptiveCardGallery />;
export default Cards;
```

Add `<AdaptiveCardGallery />` to a route. It posts the edited `CardSpec` to the
`@dbx-tools/teams` plugin's `/api/teams/card` route and renders the compiled
card. Point it at a different mount with `buildEndpoint`.

## Styles

Import the stylesheet once from the host app's Tailwind entry, after Tailwind and
your AppKit UI theme:

```css
@import "tailwindcss";
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-teams/styles.css";
```

The Teams stylesheet imports the shared `@dbx-tools/ui` foundation and uses
AppKit semantic tokens. Import it once from the host application's Tailwind
entry point.

## Package exports

- `./react`: `TeamsChat`, `DEFAULT_STARTERS`, `AdaptiveCardView`,
  `AdaptiveCardGallery`, `CARD_SAMPLES`, and the
  re-exported `Activity`, `AdaptiveCard`, `CardResult`, and `CardSpec` types.
- `./styles.css`: AppKit-token-based gallery styles and a minimal
  Adaptive Card container skin.
