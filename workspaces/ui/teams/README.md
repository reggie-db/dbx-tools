# @dbx-tools/ui-teams

React surface for the Teams add-on: render Microsoft Teams Adaptive Cards in the
browser with the [`adaptivecards`](https://www.npmjs.com/package/adaptivecards)
JavaScript renderer.

Import this package when a UI needs to display the Adaptive Card documents that
[`@dbx-tools/teams`](../../node/teams) builds. It consumes the browser-safe card
contract from [`@dbx-tools/shared-teams`](../../shared/teams) and renders through
[`@dbx-tools/ui-appkit`](../appkit)'s UI kit.

**Key features:**

- `TeamsChat` - a Teams conversation surface: each turn posts a Bot Framework
  activity to the server's `POST /api/teams/messages` endpoint - the SAME route a
  real Teams channel calls, so this is a faithful preview rather than a parallel
  implementation - and the agent's reply renders as Adaptive Card attachments,
  the way a Teams channel shows a bot's cards. (That route only answers in the
  HTTP response when the server enables its `allowUnauthenticated` development
  bypass; against a real bot registration replies go out over the Connector API,
  so point `endpoint` at `/api/teams/activity` instead.)
  Mints one conversation id per mount (which threads the server's
  agent memory), echoes the user's turn optimistically, cancels an in-flight turn
  on unmount, and offers tap-to-send starters while the transcript is empty.
- `AdaptiveCardView` - a thin React wrapper over the imperative `adaptivecards`
  renderer: feed it a compiled Adaptive Card document and it mounts the rendered
  node, re-rendering on change and wiring `Action.OpenUrl` clicks (open in a new
  tab by default, or intercept with `onOpenUrl`).
- `AdaptiveCardGallery` - a self-contained dev tool: edit a `CardSpec` (or pick a
  sample), compile it through the server's `POST /api/teams/card` route, and see
  the card render live. This is the drop-in "display them" surface for a dev
  preview page.
- Built-in `CARD_SAMPLES` covering the different parts of a card (facts, link
  actions, plain notes) so the preview shows something before you edit.
- Markdown in a `TextBlock` actually renders. A `TextBlock` is markdown per the
  Adaptive Cards spec, but `adaptivecards` ships no parser - it leaves the
  implementation (and its sanitization) to the host, so `**bold**` renders
  literally until one is installed. Importing this package registers `marked`
  as the renderer's `onProcessMarkdown` processor, degrading to plain text if a
  string fails to parse, and the stylesheet re-applies list markers / paragraph
  spacing that Tailwind's preflight resets away.

## Simulate A Teams Chat

```tsx
import { TeamsChat } from "@dbx-tools/ui-teams/react";

const Chat = () => <TeamsChat className="h-full" />;
```

Point `endpoint` elsewhere if the plugin is mounted under a different name, and
pass `agentId` to converse with a specific agent instead of the server's default.
`starters` replaces the built-in `DEFAULT_STARTERS` prompts.

## Render A Card

```tsx
import { AdaptiveCardView } from "@dbx-tools/ui-teams/react";

const Preview = ({ card }: { card: AdaptiveCard }) => (
  <AdaptiveCardView card={card} className="ac-container" />
);
```

`AdaptiveCardView` renders any compiled Adaptive Card document - one returned by
the `create_teams_card` tool, the plugin's `buildCard` export, or the
`/api/teams/card` route. Card text is treated as markdown, matching how Teams
itself renders a `TextBlock`.

## Live Preview Page

```tsx
import { AdaptiveCardGallery } from "@dbx-tools/ui-teams/react";

const Cards = () => <AdaptiveCardGallery />;
export default Cards;
```

Drop `<AdaptiveCardGallery/>` on a route. It posts the edited `CardSpec` to the
`@dbx-tools/teams` plugin's `/api/teams/card` route and renders the compiled
card, so you exercise the real server builder end to end. Point it at a
different mount with `buildEndpoint`.

## Styling

Import the stylesheet once from the host app's Tailwind entry, after Tailwind and
your AppKit-UI theme:

```css
@import "tailwindcss";
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-teams/styles.css";
```

## Modules

- `./react` - `TeamsChat`, `DEFAULT_STARTERS`, `AdaptiveCardView`,
  `AdaptiveCardGallery`, `CARD_SAMPLES`, and the
  re-exported `AdaptiveCard` / `CardResult` / `CardSpec` types.
- `./styles.css` - the AppKit-token-based styling for the gallery plus a minimal
  Adaptive Card container skin.
