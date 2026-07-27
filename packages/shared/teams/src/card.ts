/**
 * Wire-format contract for the Teams add-on: the semantic card a model drafts
 * and the Adaptive Card document that drafting compiles to. Pure (zod +
 * inferred types, no Node-only imports) so the server-side card builder, the
 * Mastra tool, and the React Adaptive Cards renderer all validate / type
 * against one definition.
 *
 * The model does NOT hand-author raw Adaptive Card JSON. It describes a card in
 * a small, high-level vocabulary ({@link CardSpec}) - a title, some text/fact
 * blocks, and optional link actions - and the builder compiles that into a
 * valid Adaptive Card 1.5 document ({@link AdaptiveCard}). Keeping the model's
 * surface small avoids the two failure modes of free-form card JSON: an invalid
 * schema the renderer rejects, and a card that renders but ignores Teams' host
 * constraints.
 *
 * Array fields intentionally avoid `.min()` / `.nonempty()`: those emit
 * `minItems` in the JSON schema, which some Model Serving endpoints reject
 * ("array types do not support minItems") when the schema is forwarded as a
 * tool definition.
 *
 * @module
 */

import { z } from "zod";

/** The Adaptive Card schema version the builder targets. Teams supports 1.5. */
export const ADAPTIVE_CARD_VERSION = "1.5";

/** The Adaptive Card `$schema` URL a well-formed document declares. */
export const ADAPTIVE_CARD_SCHEMA_URL = "http://adaptivecards.io/schemas/adaptive-card.json";

/**
 * A single labelled fact, rendered as a row in an Adaptive Card `FactSet`.
 * Facts are the right shape for compact key/value detail (status, owner, due
 * date) that would be noise as prose.
 */
export const cardFactSchema = z.object({
  title: z.string().describe('Fact label shown on the left (e.g. "Status", "Owner").'),
  value: z.string().describe('Fact value shown on the right (e.g. "Open", "alice").'),
});

/** A labelled key/value fact in a {@link CardSpec}. */
export type CardFact = z.infer<typeof cardFactSchema>;

/**
 * An action button rendered under the card body. Only an open-URL action is
 * modelled: it is the one action that is safe to render in any host without a
 * back-end wired up, and it covers the common "here is the link" case.
 */
export const cardActionSchema = z.object({
  title: z.string().describe('Button label (e.g. "Open ticket", "View run").'),
  url: z
    .string()
    .describe("Absolute https URL the button opens when tapped (an Action.OpenUrl target)."),
});

/** A link action button in a {@link CardSpec}. */
export type CardAction = z.infer<typeof cardActionSchema>;

/**
 * The high-level card a model asks to build (the tool input). Deliberately
 * small: a heading, optional supporting text, optional facts, and optional link
 * buttons. The builder turns this into a full Adaptive Card document.
 */
export const cardSpecSchema = z.object({
  title: z.string().describe("Card heading, shown bold at the top of the card."),
  subtitle: z
    .string()
    .optional()
    .describe("Optional lighter subheading under the title (e.g. a category or timestamp)."),
  text: z
    .string()
    .optional()
    .describe(
      [
        "Optional body text under the heading. A limited Markdown subset is",
        "supported by the Teams host: **bold**, _italic_, links, and '-' bullet",
        "lists. Do NOT use headings, tables, or fenced code blocks - use the",
        "`facts` array for tabular key/value detail instead.",
      ].join(" "),
    ),
  facts: z
    .array(cardFactSchema)
    .optional()
    .describe("Optional key/value rows rendered as a FactSet (label on the left, value right)."),
  actions: z
    .array(cardActionSchema)
    .optional()
    .describe("Optional link buttons rendered under the body, each opening a URL."),
});

/** The validated semantic card a model asked to build. */
export type CardSpec = z.infer<typeof cardSpecSchema>;

/**
 * The compiled Adaptive Card document - the JSON the `adaptivecards` renderer
 * consumes. Typed loosely (`elements` / `actions` as record arrays) because the
 * full Adaptive Card schema is large and host-versioned; the builder owns the
 * exact element shapes and this contract only pins the envelope every consumer
 * relies on (`type`, `version`, `body`).
 */
export const adaptiveCardSchema = z.object({
  type: z.literal("AdaptiveCard"),
  $schema: z.string(),
  version: z.string(),
  body: z.array(z.record(z.string(), z.unknown())),
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
});

/** A compiled Adaptive Card document ready to render or post to Teams. */
export type AdaptiveCard = z.infer<typeof adaptiveCardSchema>;

/**
 * The result the card tool returns: the compiled Adaptive Card plus the
 * `title` echoed back for a caller that wants a label without re-reading the
 * document. Kept separate from {@link AdaptiveCard} so the tool output stays
 * additive.
 */
export const cardResultSchema = z.object({
  title: z.string().describe("The card title, echoed for convenience."),
  card: adaptiveCardSchema.describe("The compiled Adaptive Card document."),
});

/** The result of building a card. */
export type CardResult = z.infer<typeof cardResultSchema>;
