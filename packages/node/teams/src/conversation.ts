/**
 * The Teams conversation turn: run a Mastra agent against an inbound Bot
 * Framework activity and answer with Adaptive Card attachments.
 *
 * This is the piece that makes `POST /api/teams/activity` behave like a Teams
 * bot rather than a chat API that happens to return JSON. A turn is:
 *
 *   1. read the user's text off the inbound `message` activity;
 *   2. ANSWER it - a normal tool-using agent turn, with no mention of cards, so
 *      the agent queries Genie / calls its tools exactly as it would on a
 *      streaming chat endpoint;
 *   3. FORMAT that answer into a {@link card.CardSpec} in a second pass, via
 *      Mastra's `structuredOutput` (prompt-injected, see
 *      {@link JSON_PROMPT_INJECTION});
 *   4. compile the spec with the same deterministic builder the
 *      `create_teams_card` tool uses, and attach it to an outbound activity.
 *
 * The two passes are the important part. Asking for the answer AND the card
 * shape in ONE request makes the model treat formatting as the task: it emits a
 * card straight away and never calls its tools, so a question that should have
 * queried a data source came back as "I don't have a real system connected -
 * here is a template card with placeholders". Answering first, then formatting a
 * REAL answer, makes this endpoint's content identical to the streaming
 * endpoint's; only the presentation differs.
 *
 * Formatting is also why the turn does not simply rely on the agent calling
 * `create_teams_card`: on this endpoint a card IS the response format, so it
 * should be a property of the turn rather than a tool the model may forget.
 * Agents keep the tool for the other direction - answering in prose on a normal
 * chat endpoint and choosing to attach a card. When the agent DOES call it
 * during the answering pass, that spec wins and the formatting pass is skipped.
 *
 * The conversation id doubles as the agent's memory thread id, so a client that
 * keeps posting the same `conversation.id` gets a continuous conversation - the
 * same mapping a real channel relies on.
 *
 * @module
 */

import { error, hash, json, log, object, string } from "@dbx-tools/shared-core";
import { activity as activityContract, card } from "@dbx-tools/shared-teams";
import { buildAdaptiveCard } from "./builder.ts";

const logger = log.logger("teams:conversation");

/**
 * Minimal structural shape of the Mastra `Agent` this module drives.
 *
 * Declared structurally rather than importing `@mastra/core`'s `Agent`: this
 * package must not depend on the Mastra plugin (the plugin depends on nothing
 * here either), and a turn only ever needs `generate`. Any object with a
 * compatible `generate` satisfies it, which also makes the turn trivially
 * testable with a stub.
 */
export interface CardAgentLike {
  generate(
    prompt: string,
    options: {
      structuredOutput?: {
        schema: typeof card.cardSpecSchema;
        jsonPromptInjection?: boolean | "system" | "inline";
      };
      memory?: { thread: string; resource: string };
      /**
       * Mastra's per-turn `RequestContext`. Opaque here - the object comes from
       * the agent plugin (see {@link AgentProviderLike.exports}) and is only
       * forwarded - but REQUIRED for parity with the chat endpoints: Mastra's
       * user-scoped tools read the AppKit user off it, so a turn without one
       * answers "the data source is unreachable" where chat answers with data.
       */
      requestContext?: unknown;
      abortSignal?: AbortSignal;
    },
  ): Promise<AgentResult>;
}

/**
 * The slice of Mastra's `generate` result a turn reads.
 *
 * `toolResults` matters as much as `object` here: when structured output fails
 * and the turn re-asks as prose, an agent holding the `create_teams_card` tool
 * typically CALLS it, so the best available card spec is the tool's arguments -
 * already in the right vocabulary - rather than anything in the prose.
 */
export interface AgentResult {
  object?: unknown;
  text?: string;
  toolResults?: {
    payload?: { toolName?: string; args?: unknown };
    toolName?: string;
    args?: unknown;
  }[];
}

/** Tool id whose arguments are already a {@link card.CardSpec}. */
const CARD_TOOL_NAMES = ["create_teams_card", "createCard"];

/**
 * The card spec an agent passed to the card tool, if it called it.
 *
 * Mastra nests a tool result under `payload` (`{ payload: { toolName, args } }`)
 * but has used a flat shape too, so both are read.
 */
const toolCardSpec = (result: AgentResult): card.CardSpec | null => {
  for (const entry of result.toolResults ?? []) {
    const name = entry.payload?.toolName ?? entry.toolName;
    if (!name || !CARD_TOOL_NAMES.includes(name)) continue;
    const parsed = card.cardSpecSchema.safeParse(entry.payload?.args ?? entry.args);
    if (parsed.success) return parsed.data;
  }
  return null;
};

/**
 * Ask for the card shape via PROMPT injection rather than the provider's native
 * response format.
 *
 * Databricks Model Serving rejects a request carrying both `response_format` and
 * `tools` ("Cannot specify both response_format and tools in the same request"),
 * and the agents this endpoint drives normally do have tools. Native structured
 * output would therefore fail for exactly the agents worth talking to, so the
 * schema is injected as instructions instead - which costs nothing here because
 * the answer is re-validated with `cardSpecSchema` before it is compiled.
 */
const JSON_PROMPT_INJECTION = "system" as const;

/** The bot's identity on outbound activities when the caller names none. */
export const BOT_ACCOUNT: activityContract.ChannelAccount = {
  id: "dbx-tools-teams-bot",
  name: "Databricks Agent",
};

/**
 * Instructions for the FORMATTING pass only - turning an answer the agent has
 * already produced into the card vocabulary.
 *
 * Deliberately NOT sent with the user's question. Asking for a card and an
 * answer in one request makes the model treat formatting as the task: it emits a
 * card immediately instead of calling its tools, so a question that should have
 * queried Genie came back as "I don't have a real system connected - here is a
 * template card". Formatting is a separate, second pass over a real answer.
 */
export const CARD_FORMAT_INSTRUCTIONS = [
  "Reformat the assistant answer below as a Microsoft Teams Adaptive Card.",
  "Preserve the answer's facts EXACTLY - every number, name, date and id.",
  "Do not add caveats, placeholders or invented values, and do not describe the",
  "card; if the answer states a value, that value belongs in the card.",
  "Put the headline finding in `title` and keep it under ~60 characters.",
  "Use `text` for the explanation, with '-' bullets for lists.",
  "Use `facts` for key/value detail (metrics, counts, owners, ids) instead of",
  "writing it as prose.",
  "Add `actions` only for URLs present in the answer; never invent a link.",
  "Drop any `[chart:...]` / `[data:...]` marker: a card cannot render one, so",
  "write the values it stood for into `facts` or `text` instead.",
].join(" ");

/**
 * Nudge added to the ANSWERING pass.
 *
 * The agent answers the question normally here - tools included - so this only
 * asks for the shape that survives compression into a card well. It must not
 * mention cards, or the model starts formatting instead of answering.
 */
export const CARD_ANSWER_INSTRUCTIONS = [
  "Answer using your tools and data sources as you normally would.",
  "Be concise and lead with the finding, and state concrete values",
  "(numbers, names, dates) plainly so they can be summarized.",
  // Agents on a chat endpoint are told to defer tables and charts to the host UI
  // as `[data:<id>]` / `[chart:<id>]` markers. A card has no embed slot to fill,
  // so a deferred number arrives as a literal `[data:01f1...]` in the card. The
  // turn asks for the values themselves instead, and strips any that slip
  // through (see EMBED_MARKER_RE).
  "This channel cannot display chart or data embeds: do not emit",
  "`[chart:...]` or `[data:...]` markers - write the actual numbers you",
  "retrieved into your answer instead.",
].join(" ");

/**
 * A host-embed marker (`[chart:<id>]`, `[data:<id>]`) in an agent's prose.
 *
 * Chat hosts swap these for a rendered chart or table. An Adaptive Card has no
 * such slot, so a marker that survives into card text renders as literal
 * `[data:01f1895c-...]` noise where a number should be. The answering pass asks
 * the agent not to emit them; this removes any that still arrive.
 *
 * The generic `[type:id]` grammar is spelled here rather than imported so this
 * package stays a leaf add-on with no dependency on the agent plugin's
 * contracts - it only ever needs to RECOGNIZE a marker, never resolve one.
 */
const EMBED_MARKER_RE = /\[[A-Za-z][A-Za-z0-9_-]*:[^\]\s]+\]/g;

/**
 * Drop embed markers from `text`, tidying the whitespace they leave behind so a
 * marker that sat on its own line does not become a blank one.
 */
const stripEmbedMarkers = (text: string): string =>
  text
    .replace(EMBED_MARKER_RE, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Structural shape of the sibling plugin that owns the agent registry - the
 * slice of `@dbx-tools/appkit-mastra`'s `exports()` a turn needs.
 *
 * Matched structurally, by registered plugin NAME, rather than importing the
 * Mastra plugin: this package stays a leaf add-on (it depends on no other
 * dbx-tools runtime package, like node-email), the dependency direction stays
 * one-way, and any plugin exposing the same `get` / `getDefault` pair can back
 * the endpoint.
 */
export interface AgentProviderLike {
  exports(): {
    get(id: string): unknown;
    getDefault(): unknown;
    /**
     * Builds the per-turn `RequestContext` the provider's tools expect. Optional
     * so an older provider (or a differently-shaped one) still resolves an
     * agent; the turn simply runs without user-scoped tool context then.
     */
    createRequestContext?(options: { threadId?: string; resourceId?: string }): Promise<unknown>;
  };
}

/** True when `value` exposes the `generate` a turn drives. */
const isCardAgent = (value: unknown): value is CardAgentLike =>
  typeof (value as CardAgentLike | null)?.generate === "function";

/** True when `value` exposes the agent-registry `exports()` a turn reads. */
const isAgentProvider = (value: unknown): value is AgentProviderLike =>
  typeof (value as AgentProviderLike | null)?.exports === "function";

/**
 * Read one agent out of a provider's `exports()`.
 *
 * Every member is probed before it is called: the provider is matched
 * structurally by plugin name, so a DIFFERENT plugin registered under that name
 * can satisfy `isAgentProvider` (it has an `exports()`) while exposing no agent
 * registry at all. Calling blindly would throw a `TypeError` out of route
 * resolution; a miss is just "no agent", which the route reports as 503.
 */
const readAgent = (provider: AgentProviderLike, agentId?: string): unknown => {
  const registry = provider.exports() as Partial<ReturnType<AgentProviderLike["exports"]>>;
  if (agentId) return typeof registry.get === "function" ? registry.get(agentId) : null;
  return typeof registry.getDefault === "function" ? registry.getDefault() : null;
};

/**
 * Resolve the agent that answers a turn from the AppKit plugin registry.
 *
 * `agentId` picks a specific agent; omitted, the provider's default agent
 * answers. Returns `null` when the provider is absent or the id is unknown, so
 * the route can answer 503 / 404 instead of throwing.
 */
export const resolveCardAgent = (
  plugins: ReadonlyMap<string, unknown> | undefined,
  providerName: string,
  agentId?: string,
): CardAgentLike | null => {
  const provider = plugins?.get(providerName);
  if (!isAgentProvider(provider)) return null;
  const found = readAgent(provider, agentId);
  return isCardAgent(found) ? found : null;
};

/** Options for {@link runCardTurn}. */
export interface CardTurnOptions {
  /** Cancels the agent call with the request. */
  signal?: AbortSignal;
  /** Overrides the bot identity stamped on the reply. */
  bot?: activityContract.ChannelAccount;
  /**
   * Builds the Mastra `RequestContext` for the turn, from
   * {@link resolveCardContextFactory}. Omitted, the turn still answers, but
   * without the AppKit user its user-scoped tools cannot reach Databricks - so
   * the route should always supply it.
   */
  createRequestContext?: CardContextFactory;
}

/** Builds the per-turn request context the agent's tools read. */
export type CardContextFactory = (options: {
  threadId?: string;
  resourceId?: string;
}) => Promise<unknown>;

/**
 * The agent plugin's request-context factory, when it exposes one.
 *
 * Resolved separately from the agent because it is the piece that gives an
 * out-of-band turn the same tool reach as a chat turn; a provider without it
 * still answers, just without user-scoped tools.
 */
export const resolveCardContextFactory = (
  plugins: ReadonlyMap<string, unknown> | undefined,
  providerName: string,
): CardContextFactory | null => {
  const provider = plugins?.get(providerName);
  if (!isAgentProvider(provider)) return null;
  const registry = provider.exports() as Partial<ReturnType<AgentProviderLike["exports"]>>;
  const factory = registry.createRequestContext;
  return typeof factory === "function" ? (options) => factory.call(registry, options) : null;
};

/**
 * The text a `message` activity carries, or `null` when it carries none.
 *
 * A channel sends plenty of activities with no usable text (a `typing`
 * indicator, a `conversationUpdate` when someone joins, or a `message` whose
 * payload is only an attachment). Those are not errors - they simply produce no
 * reply - so this returns `null` rather than throwing.
 */
export const promptOf = (inbound: activityContract.Activity): string | null =>
  inbound.type === "message" ? string.trimToNull(inbound.text ?? "") : null;

/**
 * Build an outbound activity carrying `cards`, addressed back to the sender of
 * `inbound`.
 *
 * Exported because a client rendering an optimistic local reply, and a test
 * asserting the envelope, both need the same construction the turn uses.
 */
export const toReplyActivity = (
  inbound: activityContract.Activity,
  cards: card.AdaptiveCard[],
  options: { bot?: activityContract.ChannelAccount; text?: string } = {},
): activityContract.Activity => ({
  type: "message",
  id: hash.id(),
  timestamp: new Date().toISOString(),
  from: options.bot ?? BOT_ACCOUNT,
  ...(inbound.from ? { recipient: inbound.from } : {}),
  ...(inbound.conversation ? { conversation: inbound.conversation } : {}),
  ...(options.text ? { text: options.text } : {}),
  attachments: cards.map((document) => activityContract.toCardAttachment(document)),
});

/**
 * Recover a {@link card.CardSpec} from a full Adaptive Card DOCUMENT.
 *
 * A capable model asked for "a Microsoft Teams Adaptive Card" often answers with
 * the finished 1.5 document instead of the small spec - correct Adaptive Card
 * JSON, wrong schema, so `structuredOutput` rejects it (`title: expected
 * string`) and a genuinely good answer is thrown away. Reading the document back
 * into the spec vocabulary keeps it: the heading TextBlocks become
 * title/subtitle, remaining TextBlocks the body, the FactSet the facts, and any
 * `Action.OpenUrl` the actions.
 *
 * Deliberately tolerant about the container: `type` may be missing and the body
 * may nest elements inside a `Container` / `ColumnSet`, so blocks are collected
 * recursively and anything unrecognized is ignored.
 */
export const documentCardSpec = (value: unknown): card.CardSpec | null => {
  if (!object.isRecord(value) || !Array.isArray(value.body)) return null;

  const texts: string[] = [];
  const facts: card.CardFact[] = [];
  const collect = (elements: unknown[]): void => {
    for (const element of elements) {
      if (!object.isRecord(element)) continue;
      if (element.type === "TextBlock") {
        const text = string.trimToNull(typeof element.text === "string" ? element.text : "");
        if (text) texts.push(text);
      } else if (element.type === "FactSet" && Array.isArray(element.facts)) {
        for (const fact of element.facts) {
          const parsed = card.cardFactSchema.safeParse(fact);
          if (parsed.success) facts.push(parsed.data);
        }
      }
      // A Container / ColumnSet / Column nests the blocks that matter.
      for (const key of ["items", "columns"]) {
        const nested = element[key];
        if (Array.isArray(nested)) collect(nested);
      }
    }
  };
  collect(value.body);

  const actions: card.CardAction[] = [];
  for (const action of Array.isArray(value.actions) ? value.actions : []) {
    if (!object.isRecord(action)) continue;
    const parsed = card.cardActionSchema.safeParse({ title: action.title, url: action.url });
    if (parsed.success) actions.push(parsed.data);
  }

  const [title, ...rest] = texts;
  if (!title) return null;
  // The second block is a subtitle only when the document styled it as one;
  // otherwise it is body text and must not be demoted to a subheading.
  const second = object.isRecord(value.body[1]) ? value.body[1] : undefined;
  const hasSubtitle = rest.length > 0 && second?.isSubtle === true;
  const body = (hasSubtitle ? rest.slice(1) : rest).join("\n\n");
  return {
    title: toTitle(title),
    ...(hasSubtitle && rest[0] ? { subtitle: rest[0] } : {}),
    ...(body ? { text: body } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
};

/**
 * The card the model produced, wherever it ended up.
 *
 * `structuredOutput` rejects anything off-schema by THROWING, and Mastra puts
 * the offending payload on the error (`details.value`) - so the model's real
 * answer is recoverable from a failed call. Both the spec shape and a full
 * Adaptive Card document are accepted, from an object or from JSON text.
 */
export const rejectedCardSpec = (err: unknown): card.CardSpec | null => {
  const details = object.isRecord(err) ? err.details : undefined;
  const value = object.isRecord(details) ? details.value : undefined;
  const candidates: unknown[] = [];
  if (typeof value === "string") {
    candidates.push(json.parse(value, undefined));
  } else if (value !== undefined) {
    candidates.push(value);
  }
  for (const candidate of candidates) {
    const spec = card.cardSpecSchema.safeParse(candidate);
    if (spec.success) return spec.data;
    const fromDocument = documentCardSpec(candidate);
    if (fromDocument) return fromDocument;
  }
  return null;
};

/**
 * Turn whatever the agent produced into a card spec.
 *
 * `structuredOutput` is best-effort in practice, not a guarantee. Because the
 * schema is prompt-injected (see {@link JSON_PROMPT_INJECTION}) rather than
 * enforced by the provider, a model can answer with prose, with JSON wrapped in
 * a ```` ```json ```` fence, or - on Databricks Model Serving - with an empty
 * parsed object while the text carries the real answer. Observed failure rate on
 * the demo endpoint was roughly one turn in three, all of which surfaced as a
 * hard `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED` and no reply at all.
 *
 * A missing card is not worth dropping the answer over, so this recovers in
 * four stages: the parsed object when it validates; else the arguments the agent
 * passed to `create_teams_card` (on the prose retry an agent holding that tool
 * usually calls it, which is a REAL card spec, not a guess); else a JSON object
 * embedded in the text; else the prose wrapped in a minimal text-only card. The
 * user always gets the agent's answer; at worst it is less structured.
 */
const toCardSpec = (result: AgentResult): card.CardSpec => {
  const parsed = card.cardSpecSchema.safeParse(result.object);
  if (parsed.success) return parsed.data;

  // A model that answered with the finished Adaptive Card document rather than
  // the spec still produced a real card; read it back into the spec vocabulary.
  const fromDocument = documentCardSpec(result.object);
  if (fromDocument) return fromDocument;

  // Prefer a card the agent explicitly composed via the tool over anything
  // scraped out of its prose.
  const fromTool = toolCardSpec(result);
  if (fromTool) return fromTool;

  const text = string.trimToNull(result.text ?? "");
  if (text) {
    // A fenced or inline JSON object in the prose: the model followed the
    // instructions but the provider did not surface a parsed object.
    const embedded = text.match(/\{[\s\S]*\}/);
    if (embedded) {
      const value = json.parse(embedded[0], undefined);
      const retry = card.cardSpecSchema.safeParse(value);
      if (retry.success) return retry.data;
      const asDocument = documentCardSpec(value);
      if (asDocument) return asDocument;
    }
    // Prose only: keep the answer, drop the structure. The first line becomes
    // the title (a card with no title renders as an untitled block), the rest
    // stays as the body.
    const lines = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      // A model introducing its own answer ("Here is the Adaptive Card:") would
      // otherwise become the card's headline, which reads as a bug. Drop the
      // preamble so the first REAL line is the title.
      .filter((line) => !PREAMBLE_RE.test(line.trim()));
    const [first, ...rest] = lines;
    const title = string.trimToNull(first ?? "") ?? "Answer";
    const body = rest.join("\n").trim();
    return {
      title: toTitle(title),
      ...(body ? { text: body } : title.length > 120 ? { text: title } : {}),
    };
  }

  throw new Error("teams: the agent returned neither a card nor any text to fall back on");
};

/**
 * A line that only announces the card rather than saying anything - e.g.
 * "Here is the Adaptive Card:", "Here's your Teams card:", "Here are the card
 * details:". Matched so it never becomes the card's title.
 *
 * Anchored to a "here is/are/here's ... card ..." opener that ENDS in a colon,
 * which is what keeps it from eating a real sentence that merely mentions a card
 * ("Here is the card reader status: offline." has text after the colon).
 */
const PREAMBLE_RE = /^(here (is|are)|here's)\b[^.!?]*\bcard\b[^.!?:]*:\s*$/i;

/**
 * Trim a line down to something usable as a card title. Adaptive Card titles are
 * a single bold line, so an overlong one is truncated rather than wrapped; the
 * markdown emphasis a model often adds is stripped since the title is already
 * styled bold.
 */
const toTitle = (value: string): string => {
  const plain = value
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  return plain.length > 120 ? `${plain.slice(0, 117)}...` : plain;
};

/**
 * Compile an answer the agent has already produced into a card spec.
 *
 * A second, deliberately stateless pass: the formatting request is NOT threaded
 * onto agent memory, so the conversation the user sees keeps only their question
 * and the answer, not the reformatting chatter in between.
 *
 * Returns `null` when the pass is unusable (Mastra throws when the model returns
 * no parsed object) so the caller can fall back to the answer text - a less
 * structured card carrying the real answer beats losing the answer.
 */
const formatAsCard = async (
  agent: CardAgentLike,
  prompt: string,
  answer: string,
  request: { abortSignal?: AbortSignal; requestContext?: unknown },
): Promise<card.CardSpec | null> => {
  const body = [
    CARD_FORMAT_INSTRUCTIONS,
    "",
    `Question: ${prompt}`,
    "",
    "Assistant answer:",
    answer,
  ].join("\n");
  const options = {
    structuredOutput: {
      schema: card.cardSpecSchema,
      jsonPromptInjection: JSON_PROMPT_INJECTION,
    },
    ...request,
  };
  // Mastra THROWS when the model returns no parsed object, and because the
  // schema is prompt-injected rather than provider-enforced that happens
  // intermittently on the same input. One retry converts most of those misses
  // into a proper card; the answer is already safe either way.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return toCardSpec(await agent.generate(body, options));
    } catch (err) {
      // The rejected payload usually IS the card - most often the full Adaptive
      // Card document rather than the spec - so it is salvaged before retrying.
      const rejected = rejectedCardSpec(err);
      if (rejected) {
        logger.debug("recovered the card from the rejected structured payload");
        return rejected;
      }
      logger.warn("card formatting pass failed", {
        attempt: attempt + 1,
        error: error.errorMessage(err),
      });
    }
  }
  logger.warn("falling back to the answer text for the card");
  return null;
};

/**
 * Run one conversation turn: drive `agent` with the inbound activity's text and
 * return the activities to append to the transcript.
 *
 * Returns an EMPTY array for an activity that carries no prompt (a typing
 * indicator, a join event), which is exactly what a bot does with one - the
 * route answers `{ activities: [] }` and the transcript is unchanged.
 *
 * Two agent calls, in this order:
 *
 *   1. the ANSWER - no `structuredOutput`, so the agent's tools are available
 *      and the content matches what the streaming endpoint would say;
 *   2. the FORMAT - {@link formatAsCard} compiling that answer into a card.
 *
 * Every failure mode still yields the answer: a card the agent composed with
 * `create_teams_card` during pass 1 short-circuits pass 2, and a failed pass 2
 * falls back to {@link toCardSpec} over the answer text.
 */
export const runCardTurn = async (
  agent: CardAgentLike,
  inbound: activityContract.Activity,
  options: CardTurnOptions = {},
): Promise<activityContract.Activity[]> => {
  const prompt = promptOf(inbound);
  if (!prompt) return [];

  const conversationId = inbound.conversation?.id;
  const userId = inbound.from?.id;
  const signal = options.signal ? { abortSignal: options.signal } : {};
  // The AppKit user rides on this, so the agent's tools (Genie, serving, the
  // model resolver) work exactly as they do on the chat endpoints. Built once
  // and shared by both passes.
  const requestContext = options.createRequestContext
    ? await options.createRequestContext({
        ...(conversationId ? { threadId: conversationId } : {}),
        ...(userId ? { resourceId: userId } : {}),
      })
    : undefined;
  const context = requestContext ? { requestContext } : {};
  // Thread the conversation onto agent memory so the same `conversation.id`
  // continues one conversation. Only passed when the client supplied both ids -
  // Mastra requires the pair, and a memory-less agent ignores it.
  const memory =
    conversationId && userId ? { memory: { thread: conversationId, resource: userId } } : {};

  const answered = await agent.generate(`${prompt}\n\n${CARD_ANSWER_INSTRUCTIONS}`, {
    ...memory,
    ...context,
    ...signal,
  });

  // An agent that composed a card itself has already said it in the right
  // vocabulary; reformatting it would only risk paraphrasing the values.
  const composed = toolCardSpec(answered);
  const answer = string.trimToNull(stripEmbedMarkers(answered.text ?? ""));
  const spec =
    composed ??
    (answer ? await formatAsCard(agent, prompt, answer, { ...context, ...signal }) : null);

  const document = buildAdaptiveCard(
    spec ?? toCardSpec({ ...answered, ...(answer ? { text: answer } : {}) }),
  );
  return [toReplyActivity(inbound, [document], { ...(options.bot ? { bot: options.bot } : {}) })];
};
