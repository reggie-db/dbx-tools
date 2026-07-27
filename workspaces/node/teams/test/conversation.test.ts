import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activity as activityContract, card } from "@dbx-tools/shared-teams";
import {
  BOT_ACCOUNT,
  documentCardSpec,
  promptOf,
  resolveCardAgent,
  rejectedCardSpec,
  resolveCardContextFactory,
  runCardTurn,
  type AgentResult,
  type CardAgentLike,
} from "../src/conversation";

/**
 * Agent stub recording every call, so a turn's inputs are assertable.
 *
 * A turn makes TWO calls (answer, then format), so the stub takes the formatting
 * pass's structured result plus - optionally - what the answering pass says.
 * Omitting `answer` makes pass 1 return the same structured spec, which is the
 * short path most assertions here only need.
 */
const stubAgent = (spec: unknown, answer?: AgentResult) => {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const agent: CardAgentLike = {
    generate: async (prompt, options) => {
      calls.push({ prompt, options: options as unknown as Record<string, unknown> });
      return calls.length === 1 && answer ? answer : { object: spec };
    },
  };
  return { agent, calls };
};

const userMessage = (text: string): activityContract.Activity => ({
  type: "message",
  text,
  from: { id: "user-1", name: "Reggie" },
  conversation: { id: "conv-1" },
});

describe("teams conversation turn", () => {
  it("answers a message with an activity carrying an Adaptive Card attachment", async () => {
    const { agent } = stubAgent({
      title: "Deployment succeeded",
      facts: [{ title: "Version", value: "1.4.2" }],
    });
    const [reply, ...rest] = await runCardTurn(agent, userMessage("did the deploy land?"));
    assert.equal(rest.length, 0);
    assert.equal(reply.type, "message");
    // Addressed back to the sender, inside the same conversation.
    assert.equal(reply.from?.id, BOT_ACCOUNT.id);
    assert.equal(reply.recipient?.id, "user-1");
    assert.equal(reply.conversation?.id, "conv-1");
    // The card rides as a Teams-tagged attachment, not a bare body field.
    assert.equal(reply.attachments?.length, 1);
    assert.equal(reply.attachments?.[0].contentType, activityContract.ADAPTIVE_CARD_CONTENT_TYPE);
    const [document] = activityContract.cardsOf(reply);
    assert.equal(document.type, "AdaptiveCard");
    assert.equal(document.version, card.ADAPTIVE_CARD_VERSION);
    // The whole reply round-trips through the wire contract.
    activityContract.activityResponseSchema.parse({ activities: [reply] });
  });

  it("threads the conversation onto agent memory so a chat continues", async () => {
    const { agent, calls } = stubAgent({ title: "Sure" });
    await runCardTurn(agent, userMessage("and the one before?"));
    assert.deepEqual(calls[0].options.memory, { thread: "conv-1", resource: "user-1" });
  });

  it("answers first WITHOUT structured output so the agent's tools can run", async () => {
    // The regression this pins: asking for the answer and the card shape in one
    // request makes the model format instead of answering, so it never queries
    // its data sources and the card comes back full of placeholders.
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const agent: CardAgentLike = {
      generate: async (prompt, options) => {
        calls.push({ prompt, options: options as unknown as Record<string, unknown> });
        return calls.length === 1
          ? { text: "Inside sales PSPW was $412.80 and gross margin was 38.4%." }
          : { object: { title: "Inside sales this week" } };
      },
    };
    await runCardTurn(agent, userMessage("what were inside sales PSPW and gross margin?"));

    assert.equal(calls.length, 2, "expected an answering pass and a formatting pass");
    assert.equal(calls[0].options.structuredOutput, undefined);
    // Nothing in the answering prompt may mention cards.
    assert.ok(!/card/i.test(calls[0].prompt), calls[0].prompt);
    assert.ok(calls[0].prompt.startsWith("what were inside sales PSPW"));
  });

  it("asks for JSON by prompt injection, not the provider response format", async () => {
    // Databricks Model Serving rejects `response_format` together with `tools`,
    // and these agents have tools - so native structured output would fail for
    // exactly the agents worth talking to.
    const { agent, calls } = stubAgent({ title: "Injected" }, { text: "An answer." });
    await runCardTurn(agent, userMessage("anything"));
    const structuredOutput = calls[1].options.structuredOutput as {
      jsonPromptInjection?: unknown;
    };
    assert.equal(structuredOutput.jsonPromptInjection, "system");
  });

  it("hands the real answer to the formatting pass, and keeps it off memory", async () => {
    // The formatting pass exists to re-present facts, so the answer text must
    // reach it verbatim; it is stateless so the reformatting request never lands
    // in the conversation the user sees.
    const answer = "Inside sales PSPW was $412.80 and gross margin was 38.4%.";
    const { agent, calls } = stubAgent({ title: "Inside sales", text: answer }, { text: answer });
    const [reply] = await runCardTurn(agent, userMessage("inside sales this week?"));

    assert.ok(calls[1].prompt.includes(answer), calls[1].prompt);
    assert.equal(calls[1].options.memory, undefined);
    // ...and the values survive into the rendered card.
    const [document] = activityContract.cardsOf(reply);
    assert.ok(
      document.body.some((block) => block.type === "TextBlock" && block.text?.includes("$412.80")),
    );
  });

  it("omits memory when the client sends no conversation or user id", async () => {
    const { agent, calls } = stubAgent({ title: "Anonymous" });
    await runCardTurn(agent, { type: "message", text: "hi" });
    assert.equal(calls[0].options.memory, undefined);
  });

  it("stays silent on activities that carry no prompt", async () => {
    const { agent } = stubAgent({ title: "unused" });
    // A typing indicator, a join event, and an empty message are all no-ops
    // rather than errors - exactly what a real bot does with them.
    assert.deepEqual(await runCardTurn(agent, { type: "typing" }), []);
    assert.deepEqual(await runCardTurn(agent, { type: "conversationUpdate" }), []);
    assert.deepEqual(await runCardTurn(agent, { type: "message", text: "   " }), []);
    assert.equal(promptOf({ type: "message", text: " hi " }), "hi");
  });

  it("rejects a structured answer that is not a valid card spec", async () => {
    // `structuredOutput` gets the model close; the turn owns the guarantee.
    const { agent } = stubAgent({ subtitle: "no title" });
    await assert.rejects(() => runCardTurn(agent, userMessage("break it")));
  });
});

/**
 * The per-turn `RequestContext`.
 *
 * The reason a card turn can answer with the same data a chat turn does: Mastra's
 * user-scoped tools (`ask_genie` above all) read the AppKit user off the request
 * context, and only the agent plugin can build one. Without it a card turn
 * answers "the data source is unreachable" while chat answers with real numbers.
 */
describe("teams turn request context", () => {
  it("passes the agent plugin's request context to BOTH passes", async () => {
    const context = { marker: "request-context" };
    const seen: unknown[] = [];
    const agent: CardAgentLike = {
      generate: async (_prompt, options) => {
        seen.push(options.requestContext);
        return seen.length === 1 ? { text: "PSPW was $412.80." } : { object: { title: "PSPW" } };
      },
    };
    const asked: unknown[] = [];
    await runCardTurn(agent, userMessage("pspw?"), {
      createRequestContext: async (options) => {
        asked.push(options);
        return context;
      },
    });
    assert.deepEqual(seen, [context, context]);
    // Threaded with the conversation so the agent's memory matches the channel.
    assert.deepEqual(asked, [{ threadId: "conv-1", resourceId: "user-1" }]);
  });

  it("still answers when the provider exposes no factory", async () => {
    const { agent, calls } = stubAgent({ title: "No context" });
    const [reply] = await runCardTurn(agent, userMessage("anything"));
    assert.equal(calls[0].options.requestContext, undefined);
    assert.equal(activityContract.cardsOf(reply).length, 1);
  });

  it("reads the factory off the agent plugin, bound to its registry", async () => {
    const registry = {
      get: () => null,
      getDefault: () => null,
      createRequestContext: async function (this: unknown, options: { threadId?: string }) {
        // `this` must be the registry: the plugin's factory is a method on the
        // object `exports()` returns, so an unbound reference would throw.
        assert.ok(this === registry);
        return { thread: options.threadId };
      },
    };
    const plugins = new Map<string, unknown>([["mastra", { exports: () => registry }]]);
    const factory = resolveCardContextFactory(plugins, "mastra");
    assert.ok(factory);
    assert.deepEqual(await factory({ threadId: "conv-9" }), { thread: "conv-9" });
    // A provider without the factory, and a missing provider, are both null.
    assert.equal(
      resolveCardContextFactory(new Map([["mastra", { exports: () => ({}) }]]), "mastra"),
      null,
    );
    assert.equal(resolveCardContextFactory(plugins, "other"), null);
  });
});

/**
 * The model answering with a finished Adaptive Card DOCUMENT.
 *
 * Asked for "a Microsoft Teams Adaptive Card", a capable model often returns the
 * full 1.5 document rather than the small spec. That is correct Adaptive Card
 * JSON but the wrong schema, so `structuredOutput` THROWS and a genuinely good
 * answer - real Genie numbers included - would be discarded in favour of a
 * scraped prose card. Mastra puts the rejected payload on the error, so it is
 * read back into the spec vocabulary instead.
 */
describe("teams document-shaped card recovery", () => {
  const document = {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: "Inside Sales PSPW $48,138, up 7.26% YoY", weight: "Bolder" },
      { type: "TextBlock", text: "Fuel Mart, this week", isSubtle: true },
      { type: "TextBlock", text: "Margin was 35.6%, flat versus 35.66%." },
      {
        type: "Container",
        items: [{ type: "FactSet", facts: [{ title: "Sales PSPW", value: "$48,138" }] }],
      },
    ],
    actions: [{ type: "Action.OpenUrl", title: "Open dashboard", url: "https://example.com/d" }],
  };

  it("reads a full Adaptive Card document back into the spec vocabulary", () => {
    const spec = documentCardSpec(document);
    assert.equal(spec?.title, "Inside Sales PSPW $48,138, up 7.26% YoY");
    // Only an `isSubtle` second block becomes the subtitle.
    assert.equal(spec?.subtitle, "Fuel Mart, this week");
    assert.equal(spec?.text, "Margin was 35.6%, flat versus 35.66%.");
    // Facts nested inside a Container are still found.
    assert.deepEqual(spec?.facts, [{ title: "Sales PSPW", value: "$48,138" }]);
    assert.deepEqual(spec?.actions, [{ title: "Open dashboard", url: "https://example.com/d" }]);
  });

  it("keeps a non-subtle second block as body text, not a subtitle", () => {
    const spec = documentCardSpec({
      body: [
        { type: "TextBlock", text: "Headline" },
        { type: "TextBlock", text: "First paragraph." },
      ],
    });
    assert.equal(spec?.subtitle, undefined);
    assert.equal(spec?.text, "First paragraph.");
  });

  it("ignores a value that is not a card document", () => {
    assert.equal(documentCardSpec({ body: [] }), null);
    assert.equal(documentCardSpec({ title: "spec, not a document" }), null);
    assert.equal(documentCardSpec("nope"), null);
  });

  it("salvages the payload Mastra rejected, as an object or as JSON text", () => {
    // Mastra's `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED` carries the model's
    // output as a string on `details.value`.
    assert.equal(
      rejectedCardSpec({ details: { value: JSON.stringify(document) } })?.title,
      "Inside Sales PSPW $48,138, up 7.26% YoY",
    );
    assert.equal(
      rejectedCardSpec({ details: { value: document } })?.subtitle,
      "Fuel Mart, this week",
    );
    // A spec-shaped payload is taken as-is.
    assert.equal(rejectedCardSpec({ details: { value: { title: "Spec" } } })?.title, "Spec");
    assert.equal(rejectedCardSpec(new Error("no payload")), null);
  });

  it("answers with the rejected card instead of falling back to prose", async () => {
    const agent: CardAgentLike = {
      generate: async (_prompt, options) => {
        if (!options.structuredOutput) return { text: "PSPW was $48,138." };
        throw Object.assign(new Error("Structured output validation failed"), {
          details: { value: JSON.stringify(document) },
        });
      },
    };
    const [reply] = await runCardTurn(agent, userMessage("pspw?"));
    const [built] = activityContract.cardsOf(reply);
    const texts = built.body.filter((block) => block.type === "TextBlock").map((b) => b.text);
    assert.equal(texts[0], "Inside Sales PSPW $48,138, up 7.26% YoY");
    // The FactSet survived, which the prose fallback could never have produced.
    assert.ok(built.body.some((block) => block.type === "FactSet"));
  });
});

describe("teams agent resolution", () => {
  const agent: CardAgentLike = { generate: async () => ({ object: { title: "ok" } }) };
  const provider = {
    exports: () => ({
      get: (id: string) => (id === "support" ? agent : null),
      getDefault: () => agent,
    }),
  };

  it("resolves the default agent, and a named one by id", () => {
    const plugins = new Map<string, unknown>([["mastra", provider]]);
    assert.equal(resolveCardAgent(plugins, "mastra"), agent);
    assert.equal(resolveCardAgent(plugins, "mastra", "support"), agent);
  });

  it("returns null for an unknown agent id or a missing provider", () => {
    const plugins = new Map<string, unknown>([["mastra", provider]]);
    assert.equal(resolveCardAgent(plugins, "mastra", "nope"), null);
    assert.equal(resolveCardAgent(plugins, "other"), null);
    assert.equal(resolveCardAgent(undefined, "mastra"), null);
  });

  it("ignores a registered plugin that does not provide agents", () => {
    const plugins = new Map<string, unknown>([["mastra", { exports: () => ({}) }]]);
    assert.equal(resolveCardAgent(plugins, "mastra"), null);
  });
});

/**
 * Recovery when `structuredOutput` doesn't produce a card.
 *
 * The schema is prompt-injected rather than provider-enforced (Databricks Model
 * Serving rejects `response_format` alongside `tools`), so a model can answer
 * with prose or with JSON in the text while `object` comes back empty. Observed
 * live at roughly one turn in three. A card is the response FORMAT, not the
 * answer, so the answer must survive.
 */
describe("teams turn output recovery", () => {
  const message = (text: string): activityContract.Activity => ({
    type: "message",
    text,
    from: { id: "user-1" },
    conversation: { id: "conv-1" },
  });

  /** Read the compiled card off the first reply activity. */
  const cardOf = (activities: activityContract.Activity[]) =>
    activityContract.cardsOf(activities[0]!)[0]!;

  /** The text of every `TextBlock` in a compiled card. */
  const textsOf = (document: card.AdaptiveCard) =>
    document.body.filter((block) => block.type === "TextBlock").map((block) => block.text);

  it("recovers a JSON card the model wrote into the text", async () => {
    const agent: CardAgentLike = {
      generate: async () => ({
        object: undefined,
        text: '```json\n{"title":"Warehouse healthy","facts":[{"title":"State","value":"RUNNING"}]}\n```',
      }),
    };
    const document = cardOf(await runCardTurn(agent, message("is the warehouse healthy?")));
    assert.ok(textsOf(document).includes("Warehouse healthy"));
    // The facts survived the recovery, not just the title.
    const facts = document.body.find((block) => block.type === "FactSet");
    assert.deepEqual(facts?.facts, [{ title: "State", value: "RUNNING" }]);
  });

  it("wraps a prose-only answer in a text card instead of failing the turn", async () => {
    const agent: CardAgentLike = {
      generate: async () => ({
        object: undefined,
        text: "The warehouse is healthy.\nIt has been running for 3 hours.",
      }),
    };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    const texts = textsOf(document);
    assert.equal(texts[0], "The warehouse is healthy.");
    assert.ok(texts.some((text) => text?.includes("running for 3 hours")));
  });

  // Mastra THROWS (rather than returning an empty object) when validation fails.
  // The answer is already in hand by then, so a failed formatting pass costs
  // structure, never the answer.
  it("keeps the answer when the formatting pass throws", async () => {
    const passes: number[] = [];
    const agent: CardAgentLike = {
      generate: async (_prompt, options) => {
        passes.push(options.structuredOutput ? 1 : 0);
        if (options.structuredOutput) throw new Error("Structured output validation failed");
        return { text: "Recovered answer" };
      },
    };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    // One answering pass, then the formatting pass and its single retry.
    assert.deepEqual(passes, [0, 1, 1], "expected an answering pass then two format attempts");
    assert.ok(textsOf(document).includes("Recovered answer"));
  });

  // Chat hosts swap `[data:<id>]` / `[chart:<id>]` for a rendered table or
  // chart. A card has no such slot, so a marker that survives renders as literal
  // `[data:01f1...]` noise exactly where a number belongs.
  it("strips host embed markers instead of rendering them as text", async () => {
    const formatted: string[] = [];
    const agent: CardAgentLike = {
      generate: async (prompt, options) => {
        if (!options.structuredOutput) {
          return {
            text: "Inside sales PSPW was $412.80.\n[data:01f1895c-9d9e-1b33-94d6-b402b79b85f8]\nMargin held flat.",
          };
        }
        formatted.push(prompt);
        throw new Error("Structured output validation failed");
      },
    };
    const document = cardOf(await runCardTurn(agent, message("pspw?")));
    const rendered = textsOf(document).join("\n");
    assert.ok(!rendered.includes("[data:"), rendered);
    assert.ok(rendered.includes("$412.80"));
    assert.ok(rendered.includes("Margin held flat."));
    // The formatting pass never sees the marker either (its own instructions
    // name the syntax, so this checks for the marker's id, not the prefix).
    assert.ok(formatted.every((prompt) => !prompt.includes("01f1895c")));
  });

  it("still fails when the agent returns neither a card nor any text", async () => {
    const agent: CardAgentLike = { generate: async () => ({}) };
    await assert.rejects(runCardTurn(agent, message("status?")), /neither a card nor any text/);
  });

  it("truncates an overlong first line into a usable title", async () => {
    const long = "x".repeat(400);
    const agent: CardAgentLike = { generate: async () => ({ text: long }) };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    const [title] = textsOf(document);
    assert.ok((title?.length ?? 0) <= 120, `title was ${title?.length} chars`);
    assert.ok(title?.endsWith("..."));
  });
});

/**
 * The card TOOL as a short-circuit, and prose recovery behind it.
 *
 * An agent holding `create_teams_card` may call it during the answering pass;
 * those arguments are a real, already-validated card spec, so they win outright
 * and the formatting pass is skipped - reformatting them could only paraphrase
 * the values. Everything else falls back to scraping the answer text, which is
 * why a self-announcing line like "Here is the Adaptive Card:" must not become
 * the title.
 */
describe("teams turn tool-call recovery", () => {
  const message = (text: string): activityContract.Activity => ({
    type: "message",
    text,
    from: { id: "user-1" },
    conversation: { id: "conv-1" },
  });

  const cardOf = (activities: activityContract.Activity[]) =>
    activityContract.cardsOf(activities[0]!)[0]!;

  const titleOf = (document: card.AdaptiveCard) =>
    document.body.find((block) => block.type === "TextBlock")?.text;

  it("prefers the spec the agent passed to create_teams_card over its prose", async () => {
    let calls = 0;
    const agent: CardAgentLike = {
      generate: async () => ({
        text: "Here is the Adaptive Card:",
        toolResults: [
          {
            payload: {
              toolName: "create_teams_card",
              args: {
                title: "Warehouse health isn't available here",
                facts: [{ title: "Status", value: "Unavailable" }],
              },
            },
          },
        ],
      }),
    };
    const counting: CardAgentLike = {
      generate: async (prompt, options) => {
        calls += 1;
        return agent.generate(prompt, options);
      },
    };
    const document = cardOf(await runCardTurn(counting, message("is the warehouse healthy?")));
    assert.equal(titleOf(document), "Warehouse health isn't available here");
    assert.equal(calls, 1, "a tool-composed card should skip the formatting pass");
  });

  it("also reads a flat tool-result shape", async () => {
    const agent: CardAgentLike = {
      generate: async () => ({
        text: "Here's your card:",
        toolResults: [{ toolName: "create_teams_card", args: { title: "Flat shape works" } }],
      }),
    };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    assert.equal(titleOf(document), "Flat shape works");
  });

  it("ignores an unrelated tool's arguments", async () => {
    const agent: CardAgentLike = {
      generate: async () => ({
        text: "The deploy succeeded.",
        toolResults: [{ payload: { toolName: "web_search", args: { title: "not a card" } } }],
      }),
    };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    assert.equal(titleOf(document), "The deploy succeeded.");
  });

  it("drops a self-announcing preamble instead of making it the title", async () => {
    for (const preamble of [
      "Here is the Adaptive Card:",
      "Here's your Teams Adaptive Card:",
      "Here are the card details:",
    ]) {
      const agent: CardAgentLike = {
        generate: async () => ({ text: `${preamble}\nThe warehouse is healthy.` }),
      };
      const document = cardOf(await runCardTurn(agent, message("status?")));
      assert.equal(titleOf(document), "The warehouse is healthy.", `failed for: ${preamble}`);
    }
  });

  it("strips markdown emphasis from a recovered title", async () => {
    const agent: CardAgentLike = {
      generate: async () => ({ text: "**Warehouse healthy**\nAll clear." }),
    };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    assert.equal(titleOf(document), "Warehouse healthy");
  });

  it("keeps a sentence that merely mentions a card", async () => {
    const agent: CardAgentLike = {
      generate: async () => ({ text: "Here is the card reader status: offline." }),
    };
    const document = cardOf(await runCardTurn(agent, message("status?")));
    assert.equal(titleOf(document), "Here is the card reader status: offline.");
  });
});
