# @dbx-tools/shared-teams

Browser-safe Adaptive Card and Bot Framework activity schemas (plus inferred
types) for the Teams add-on.

Import this package when a UI, Mastra tool schema, server route, or test needs
to validate the same Adaptive Card payloads that
[`@dbx-tools/teams`](../../node/teams) builds and
[`@dbx-tools/ui-teams`](../../ui/teams) renders.

Key features:

- High-level `CardSpec` contract - the small, model-friendly vocabulary a model
  drafts (title, subtitle, text, facts, link actions) instead of hand-authoring
  raw Adaptive Card JSON.
- `AdaptiveCard` envelope schema for the compiled Adaptive Card 1.5 document the
  `adaptivecards` renderer consumes and Teams accepts.
- `CardResult` schema for the build response returned to a model or a browser.
- `Activity` contract for the conversation endpoint - the Bot Framework envelope
  a Teams channel exchanges, with `CardAttachment` tagging a card as
  `application/vnd.microsoft.card.adaptive`, plus the `toCardAttachment` /
  `cardsOf` helpers both sides use so attachments are wrapped and read
  identically. Unknown activity fields are preserved rather than stripped, since
  a real channel sends far more than this reads.
- Model/tool-friendly schemas that avoid JSON Schema constraints known to cause
  problems with some serving endpoints (no array `minItems`).

## Validate A Drafted Card

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

## Validate A Compiled Card

```ts
const result = card.cardResultSchema.parse(await response.json());
// result.card is a full Adaptive Card document ready to render or post to Teams.
```

`adaptiveCardSchema` pins the envelope every consumer relies on (`type`,
`$schema`, `version`, `body`); the builder in `@dbx-tools/teams` owns the exact
element shapes inside `body` / `actions`.

## Modules

- `card` - `cardFactSchema`, `cardActionSchema`, `cardSpecSchema`,
  `adaptiveCardSchema`, `cardResultSchema`, the `ADAPTIVE_CARD_VERSION` /
  `ADAPTIVE_CARD_SCHEMA_URL` constants, and flat inferred types: `CardFact`,
  `CardAction`, `CardSpec`, `AdaptiveCard`, and `CardResult`.
- `activity` - `activitySchema`, `activityRequestSchema`,
  `activityResponseSchema`, `cardAttachmentSchema`, `channelAccountSchema`,
  `conversationAccountSchema`, the `ADAPTIVE_CARD_CONTENT_TYPE` /
  `ACTIVITY_TYPES` constants, the `toCardAttachment` / `cardsOf` helpers, and
  the `Activity`, `ActivityRequest`, `ActivityResponse`, `CardAttachment`,
  `ChannelAccount`, `ConversationAccount`, and `ActivityType` types.

The schemas intentionally avoid array `.min()` constraints so they can be reused
as model/tool JSON schemas for serving endpoints that reject `minItems`.
