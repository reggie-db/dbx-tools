# @dbx-tools/shared-teams

Validate Microsoft Teams Adaptive Card and Bot Framework activity payloads in
browser and server code. It defines the shared Zod schemas, inferred types,
attachment helpers, and constants. The
[@dbx-tools/teams](../../node/teams) server package builds these payloads, and
[@dbx-tools/ui-teams](../../ui/teams) renders them.

## Quick start

```ts
import { card } from "@dbx-tools/shared-teams";

const spec = card.cardSpecSchema.parse({
  title: "Deployment succeeded",
  text: "The API service rolled out cleanly.",
});
```

Use these contracts and builders for:

- High-level `CardSpec` contract: the small, model-friendly vocabulary a model
  drafts (title, subtitle, text, facts, link actions) instead of hand-authoring
  raw Adaptive Card JSON.
- `AdaptiveCard` envelope schema for the compiled Adaptive Card 1.5 document the
  `adaptivecards` renderer consumes and Teams accepts.
- `CardResult` schema for the build response returned to a model or a browser.
- `Activity` contract for the conversation endpoint: the Bot Framework envelope
  a Teams channel exchanges, with `CardAttachment` tagging a card as
  `application/vnd.microsoft.card.adaptive`, plus the `toCardAttachment` /
  `cardsOf` helpers both sides use so attachments are wrapped and read
  identically. Unknown activity fields are preserved rather than stripped
  because a real channel sends far more than this package reads.
- Model/tool-friendly schemas that avoid JSON Schema constraints known to cause
  problems with some serving endpoints (no array `minItems`).

## Validate card fields

```ts
import { card, type CardSpec } from "@dbx-tools/shared-teams";

const spec: CardSpec = card.cardSpecSchema.parse({
  title: "Deployment succeeded",
  subtitle: "prod • 2m ago",
  text: "The **api** service rolled out cleanly.",
  facts: [
    { title: "Version", value: "1.4.2" },
    { title: "Owner", value: "alice" },
  ],
  actions: [{ title: "View run", url: "https://example.com/runs/42" }],
});
```

The spec schema is intentionally small so a model produces valid input rather
than free-form card JSON the renderer would reject.

## Validate a compiled card

```ts
const result = card.cardResultSchema.parse(await response.json());
// result.card is a full Adaptive Card document ready to render or post to Teams.
```

`adaptiveCardSchema` validates the common envelope fields: `type`, `$schema`,
`version`, and `body`. The builder in
[@dbx-tools/teams](../../node/teams) defines the exact element shapes inside
`body` and `actions`.

## Runtime boundary

This package doesn't render cards, run agents, validate Microsoft Bot Framework
tokens, or post to Teams. Use [@dbx-tools/teams](../../node/teams) for those
server operations and [@dbx-tools/ui-teams](../../ui/teams) for React
rendering.

## Package exports

- `card`: `cardFactSchema`, `cardActionSchema`, `cardSpecSchema`,
  `adaptiveCardSchema`, `cardResultSchema`, the `ADAPTIVE_CARD_VERSION` /
  `ADAPTIVE_CARD_SCHEMA_URL` constants, and flat inferred types: `CardFact`,
  `CardAction`, `CardSpec`, `AdaptiveCard`, and `CardResult`.
- `teamsActivity`: `activitySchema`, `activityRequestSchema`,
  `activityResponseSchema`, `cardAttachmentSchema`, `channelAccountSchema`,
  `conversationAccountSchema`, the `ADAPTIVE_CARD_CONTENT_TYPE` /
  `ACTIVITY_TYPES` constants, the `toCardAttachment` / `cardsOf` helpers, and
  the `Activity`, `ActivityRequest`, `ActivityResponse`, `CardAttachment`,
  `ChannelAccount`, `ConversationAccount`, and `ActivityType` types.

The schemas intentionally avoid array `.min()` constraints so they can be reused
as model/tool JSON schemas for serving endpoints that reject `minItems`.
