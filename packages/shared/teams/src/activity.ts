/**
 * Wire-format contract for the Teams conversation endpoint: the Bot Framework
 * `Activity` a Teams-like client posts, and the activity (carrying Adaptive Card
 * attachments) the agent answers with.
 *
 * Why this shape rather than a bespoke `{ message }` envelope: Teams does not
 * speak a custom chat API. A channel delivers a bot a JSON `Activity` and reads
 * back activities whose `attachments` carry
 * `application/vnd.microsoft.card.adaptive` payloads. Modelling the real
 * protocol here means the same endpoint that backs the in-repo preview chat is
 * the one a Bot Framework channel could call - the analogue of how the Mastra
 * plugin exposes MCP at a path rather than inventing a tool-call API.
 *
 * Only the subset the conversation endpoint actually reads or writes is
 * modelled. `Activity` is a large, evolving envelope, so unknown fields are
 * PRESERVED rather than stripped (see {@link activitySchema}) - a channel sends
 * far more than this, and dropping it would corrupt a round-trip.
 *
 * @module
 */

import { z } from "zod";
import { adaptiveCardSchema } from "./card";

/** The attachment content type Teams uses for an Adaptive Card. */
export const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** Bot Framework activity types this endpoint understands. */
export const ACTIVITY_TYPES = ["message", "conversationUpdate", "typing"] as const;

/** A Bot Framework activity type. */
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * A participant in a conversation. `id` is the stable key; `name` is the
 * display label a chat transcript shows.
 */
export const channelAccountSchema = z.object({
  id: z.string().describe("Stable id of the user or bot."),
  name: z.string().optional().describe("Display name shown in the transcript."),
});

/** A conversation participant (user or bot). */
export type ChannelAccount = z.infer<typeof channelAccountSchema>;

/**
 * The conversation an activity belongs to. The `id` is what maps onto a Mastra
 * memory thread, so a client that keeps sending the same id gets a continuous
 * conversation.
 */
export const conversationAccountSchema = z.object({
  id: z.string().describe("Conversation id; maps to the agent's memory thread."),
});

/** The conversation an activity belongs to. */
export type ConversationAccount = z.infer<typeof conversationAccountSchema>;

/**
 * An Adaptive Card attachment - how a card reaches a Teams client. The card
 * document lives under `content`, tagged by `contentType`.
 */
export const cardAttachmentSchema = z.object({
  contentType: z.literal(ADAPTIVE_CARD_CONTENT_TYPE),
  content: adaptiveCardSchema.describe("The compiled Adaptive Card document."),
});

/** An Adaptive Card attachment on an activity. */
export type CardAttachment = z.infer<typeof cardAttachmentSchema>;

/**
 * A Bot Framework activity.
 *
 * `.passthrough()` is deliberate: a real channel sends `channelId`,
 * `serviceUrl`, `timestamp`, `replyToId`, `channelData` and more. This endpoint
 * reads only what it needs, but an unknown field is part of the caller's
 * envelope and is kept so a client can round-trip its own metadata.
 */
export const activitySchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES).describe("Activity type; `message` carries user text."),
    id: z.string().optional().describe("Activity id, assigned by the sender."),
    text: z.string().optional().describe("Message text, present on a `message` activity."),
    from: channelAccountSchema.optional().describe("Who sent the activity."),
    recipient: channelAccountSchema.optional().describe("Who the activity is addressed to."),
    conversation: conversationAccountSchema
      .optional()
      .describe("Conversation the activity belongs to."),
    attachments: z
      .array(cardAttachmentSchema)
      .optional()
      .describe("Adaptive Card attachments carried by the activity."),
    timestamp: z.string().optional().describe("ISO-8601 time the activity was created."),
  })
  .passthrough();

/** A Bot Framework activity. */
export type Activity = z.infer<typeof activitySchema>;

/**
 * The request body the conversation endpoint accepts: an inbound activity plus
 * optional routing hints that are NOT part of the Bot Framework envelope
 * (which agent to run, which serving model to use). Keeping them as siblings of
 * `activity` leaves the protocol payload untouched.
 */
export const activityRequestSchema = z.object({
  activity: activitySchema.describe("The inbound Bot Framework activity."),
  agentId: z
    .string()
    .optional()
    .describe("Mastra agent to answer with. Defaults to the plugin's default agent."),
  model: z.string().optional().describe("Optional serving-endpoint override for this turn."),
});

/** A request to the Teams conversation endpoint. */
export type ActivityRequest = z.infer<typeof activityRequestSchema>;

/**
 * The endpoint's response: the activities to append to the transcript. An array
 * because one turn may answer with several activities (Teams itself allows a
 * bot to send more than one reply), and because a future streaming/typing
 * variant can grow into the same shape without a breaking change.
 */
export const activityResponseSchema = z.object({
  activities: z.array(activitySchema).describe("Activities the bot replies with."),
});

/** The response from the Teams conversation endpoint. */
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

/**
 * Wrap a compiled Adaptive Card as a Teams attachment.
 *
 * Browser-safe and shared so the server (building a reply) and any client
 * (rendering an optimistic local activity) tag attachments identically.
 */
export const toCardAttachment = (card: z.infer<typeof adaptiveCardSchema>): CardAttachment => ({
  contentType: ADAPTIVE_CARD_CONTENT_TYPE,
  content: card,
});

/** Read the Adaptive Card documents carried by an activity, if any. */
export const cardsOf = (activity: Activity): z.infer<typeof adaptiveCardSchema>[] =>
  (activity.attachments ?? [])
    .filter((attachment) => attachment.contentType === ADAPTIVE_CARD_CONTENT_TYPE)
    .map((attachment) => attachment.content);
