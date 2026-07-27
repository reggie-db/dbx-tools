# @dbx-tools/teams

Server-side Microsoft Teams Adaptive Card runtime, agent tool, and AppKit
plugin.

Import this package when an AppKit or Mastra backend needs to answer like a
Teams bot - a conversation endpoint whose replies are Adaptive Cards - or to turn
a model's short, structured description of a status/result into a valid Teams
Adaptive Card to render in a preview UI or post to a channel. AppKit ships no
first-party Teams / Adaptive Card surface, so this is additive rather than an
alternative to a native plugin. The browser-safe card schemas live in
[`@dbx-tools/shared-teams`](../../shared/teams), and the React renderer (the
`adaptivecards` JavaScript renderer) lives in
[`@dbx-tools/ui-teams`](../../ui/teams).

**Key features:**

- AppKit plugin registration that resolves config, logs the effective card
  version and webhook state at boot, and mounts card-build / card-post routes.
- Two agent surfaces over one runtime: a Mastra `create_teams_card` tool and an
  AppKit `teams.createCard` tool, both taking the small `CardSpec` vocabulary.
- A deterministic builder that compiles a `CardSpec` (title, subtitle, text,
  key/value facts, link actions) into a valid Adaptive Card 1.5 document, so a
  card is well-formed by construction rather than by hoping the model produced
  correct schema.
- Optional posting to a Teams incoming webhook, wrapped in the attachment
  envelope Teams expects, with a retrying execution policy.
- `POST /api/teams/messages` - the REAL Microsoft Teams messaging endpoint: the
  URL you paste into an Azure Bot registration so a Teams channel can chat with
  your agents. It validates the Bot Service JWT (signature, issuer, and an
  audience equal to your bot's app id), acknowledges immediately, and delivers
  the agent's card back over the Bot Framework Connector API. This is the
  Teams-shaped analogue of how the Mastra plugin exposes MCP at a path - the
  protocol is the interface.
- `POST /api/teams/activity` - the same turn, run SYNCHRONOUSLY with the reply
  activities in the response body. No bot registration required, so this is what
  a local client, a test, or any non-Teams caller uses. The conversation id maps
  onto the agent's memory thread, so repeat turns continue one conversation.
- `POST /api/teams/card` route a browser dev page posts to for a live card
  preview, and `POST /api/teams/post` to push a card to the webhook.

## Register The AppKit Plugin

```ts
import { createApp, server } from "@databricks/appkit";
import { plugin as teamsPlugin, tool as teamsTool } from "@dbx-tools/teams";
import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
  instructions: "Summarize results as Teams cards when asked.",
  tools: () => ({ create_teams_card: teamsTool.teamsCardTool() }),
});

await createApp({
  plugins: [
    server(),
    teamsPlugin.teams({ webhookUrl: process.env.TEAMS_WEBHOOK_URL }),
    mastraPlugin.mastra({ agents: support, storage: true }),
  ],
});
```

`plugin.teams()` resolves config, primes the shared runtime, logs the effective
card version and whether a webhook is wired up, and mounts the build / post
routes under `/api/teams`. `tool.teamsCardTool()` creates the Mastra
`create_teams_card` tool; the AppKit `teams.createCard` tool is the same
capability for an AppKit agent and is auto-inheritable because building a card
has no side effects.

## Converse In Cards

```bash
curl -X POST http://localhost:8000/api/teams/activity \
  -H 'content-type: application/json' \
  -d '{
        "activity": {
          "type": "message",
          "text": "did the deploy land?",
          "from": { "id": "user-1", "name": "Reggie" },
          "conversation": { "id": "conv-1" }
        }
      }'
```

The reply is `{ "activities": [...] }`, each activity carrying
`attachments[].contentType === "application/vnd.microsoft.card.adaptive"` with a
compiled Adaptive Card under `content` - what a Teams client renders.

A turn runs in two passes, and the order is the whole point:

1. **Answer.** The agent answers the question normally - its tools available, no
   `structuredOutput`, and nothing about cards in the prompt.
2. **Format.** A second `structuredOutput` pass reformats that answer into a
   `CardSpec`, which the builder compiles.

Asking for the answer AND the card shape in one request makes the model treat
formatting as the task: it emits a card immediately, never calls its tools, and a
question that should have queried Genie comes back as "I don't have a real system
connected - here is a template card". Answering first means this endpoint's
CONTENT matches what the streaming chat endpoint would say; only the
presentation differs. Agents keep `create_teams_card` for the other direction -
answering in prose on a chat endpoint and choosing to attach a card - and when
the agent calls it during pass 1, that spec wins and pass 2 is skipped.

Because the schema is prompt-injected rather than provider-enforced (Databricks
Model Serving rejects `response_format` alongside `tools`), the format pass is
best-effort, so the answer is recovered in layers: the parsed spec, a full
Adaptive Card DOCUMENT read back into the spec vocabulary (what a capable model
often returns when asked for "an Adaptive Card"), the payload Mastra rejected off
the thrown error, JSON embedded in prose, then the prose itself. A formatting
miss costs structure, never the answer.

Host embed markers (`[data:<id>]`, `[chart:<id>]`) are stripped from the answer:
a chat UI swaps those for a rendered table or chart, but a card has no such slot,
so a marker would render as literal `[data:01f1...]` where a number belongs. The
answering pass asks the agent for the values themselves instead.

The agent is resolved from the sibling Mastra plugin by registered name
(`agentPlugin`, default `mastra`), so this package stays a leaf add-on and takes
no dependency on `@dbx-tools/appkit-mastra`. Pass `agentId` in the body to pick a
specific agent; omit it for the default one. An unmounted agent plugin answers
503, an unknown `agentId` answers 404.

The same lookup fetches the plugin's `createRequestContext()`, which builds the
per-turn Mastra `RequestContext` the turn passes to both passes. This is required
for parity with chat: user-scoped tools read the AppKit user off that context, so
without it `ask_genie` answers "the data source is unreachable" while the chat
routes answer with real numbers. A provider that exposes no factory still serves
turns, just without user-scoped tools.

Activities that carry no prompt - a `typing` indicator, a `conversationUpdate`
when someone joins, an empty message - answer `{ "activities": [] }` rather than
erroring, which is what a real bot does with them.

[`@dbx-tools/ui-teams`](../../ui/teams)'s `TeamsChat` is the matching client.

## Build A Card Directly

```ts
import { builder } from "@dbx-tools/teams";

const { card } = builder.buildCardResult({
  title: "Deployment succeeded",
  subtitle: "prod • 2m ago",
  facts: [{ title: "Version", value: "1.4.2" }],
  actions: [{ title: "View run", url: "https://example.com/runs/42" }],
});
// `card` is a full Adaptive Card document; render it with @dbx-tools/ui-teams
// or post it with the plugin's `postCard` export.
```

## Why Use This Over Native AppKit

AppKit has no Teams or Adaptive Card surface at all, so use this whenever an
agent should emit a Teams card. The value is the policy layer around a card: the
model works in a small, safe vocabulary (`CardSpec`) instead of raw Adaptive
Card JSON, the builder guarantees a schema-valid Adaptive Card 1.5 document, and
posting is gated behind an explicitly configured incoming webhook. Same add-on
shape as [`@dbx-tools/email`](../email).

## Configuration

Precedence per field: explicit plugin config wins, then the matching
environment variable.

- `cardVersion` / `TEAMS_CARD_VERSION` - Adaptive Card schema version the
  builder targets. Defaults to `1.5` (what Teams supports).
- `webhookUrl` / `TEAMS_WEBHOOK_URL` - optional Teams incoming-webhook URL. When
  unset, posting is disabled and the plugin only builds cards for a UI to
  render. A value that is not an absolute URL fails config resolution.
- `agentPlugin` / `TEAMS_AGENT_PLUGIN` - registered name of the sibling plugin
  whose agents answer a conversation turn. Defaults to `mastra`; set it when the
  Mastra plugin is mounted under a `config.name` override.
- `appId` / `TEAMS_APP_ID` (alias `MICROSOFT_APP_ID`) - the Entra app (client)
  id from your Azure Bot registration. Required before `POST /messages` accepts
  anything: it is the audience an inbound token must carry.
- `appPassword` / `TEAMS_APP_PASSWORD` (alias `MICROSOFT_APP_PASSWORD`) - client
  secret for that app id, used to fetch the outbound Connector token.
- `appTenantId` / `TEAMS_APP_TENANT_ID` (alias `MICROSOFT_APP_TENANT_ID`) - set
  only for a SINGLE-tenant bot; leave unset for multi-tenant.
- `allowUnauthenticated` / `TEAMS_ALLOW_UNAUTHENTICATED` - serve `/messages`
  with NO token validation, replying in the HTTP response instead of through the
  Connector API. For local development only, and ignored unless `NODE_ENV` is
  `development`, so a production build cannot be talked into it by an
  environment variable. See "Connect A Real Teams Channel".

The `MICROSOFT_APP_*` aliases are the names the Bot Framework SDK and the Azure
portal already use, so an existing bot's environment drops in unchanged.

## Connect A Real Teams Channel

1. Create an **Azure Bot** resource and note its **Microsoft App ID**; create a
   client secret for it.
2. Set its **Messaging endpoint** to `https://<your-app-host>/api/teams/messages`.
3. Enable the **Microsoft Teams** channel on the bot.
4. Give the app `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` (plus
   `TEAMS_APP_TENANT_ID` for a single-tenant registration).
5. Install the bot in Teams (via a Teams app manifest referencing the same app
   id) and message it. The agent answers in Adaptive Cards.

What the endpoint does on each inbound request:

- **Validates the JWT** against the Bot Framework JWKS, requiring a trusted
  issuer and an audience equal to `appId`. The audience check is the one that
  matters: a token the Bot Service issued for someone ELSE's bot is signed by the
  same keys, so without it anyone with their own bot could drive your agent.
- **Pins the reply destination to the token.** `serviceUrl` arrives in the
  request body, and replies carry your bot's credentials, so it is honored only
  when it matches the verified token's own `serviceurl` claim.
- **Answers `200` before running the agent.** Bot Service times out an
  unacknowledged activity in seconds and retries it, while a card takes longer
  than that - so a synchronous reply would produce duplicate cards. The typing
  indicator shows while the agent works, and the card is delivered through the
  Connector API when it is ready.

For local development without a registration, set `allowUnauthenticated: true`
(with `NODE_ENV=development`) and `/messages` will answer in the HTTP response,
which is how the in-repo demo renders live cards.

## Routes

Mounted under the plugin base path `/api/teams`:

- `POST /messages` - the Teams messaging endpoint (see above). Body is a bare Bot
  Framework activity. `401` on a token that fails validation, `503` when no
  `appId`/`appPassword` is configured, `400` on an invalid activity or a
  `serviceUrl` that does not match the token. Answers `200` with an empty body;
  the reply arrives over the Connector API.
- `POST /activity` - run one conversation turn. Body is
  `{ activity, agentId?, model? }`; the response is `{ activities }`, each
  carrying Adaptive Card attachments. `400` on an invalid activity, `404` on an
  unknown `agentId`, `503` when no agent plugin is registered.
- `POST /card` - compile a `CardSpec` request body into an Adaptive Card
  document. The dev display page posts here to preview cards live.
- `POST /post` - compile then push a `CardSpec` to the configured Teams
  incoming webhook; a `400` when the body is invalid, an error when no webhook
  is configured.

## Modules

- `plugin` - `teams` (the plugin factory) and `TeamsPlugin`.
- `tool` - `teamsCardTool` and `CREATE_CARD_DESCRIPTION`.
- `builder` - `buildAdaptiveCard` / `buildCardResult` (pure `CardSpec` -> card
  compilation).
- `conversation` - `runCardTurn` (one activity in, card activities out),
  `resolveCardAgent`, `promptOf`, `toReplyActivity`, `CARD_TURN_INSTRUCTIONS`,
  and the `CardAgentLike` / `AgentProviderLike` shapes.
- `auth` - `verifyBotToken` (inbound Bot Service JWT validation),
  `connectorToken` (outbound client-credentials token), `isAllowedServiceUrl`,
  and `resetTeamsAuth`.
- `connector` - `sendActivity` / `sendTyping`, the Bot Framework Connector API
  calls a reply is delivered through.
- `messaging` - `deliverTurn` (acknowledge-then-deliver turn) and
  `resolveServiceUrl`.
- `runtime` - `getTeamsRuntime`, `setTeamsExecutor`, `buildCard`, `postCard`,
  and the `TeamsExecutor` / `TeamsRuntime` types.
- `config` - `resolveTeamsConfig`, `TEAMS_CONFIG_SCHEMA`, the env-name
  constants, and the `TeamsPluginConfig` / `ResolvedTeamsConfig` types.
- `defaults` - the interceptor execution settings and named caps.
