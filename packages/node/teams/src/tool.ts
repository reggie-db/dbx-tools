/**
 * The `create_teams_card` Mastra tool: a model describes a card in the small
 * {@link card.CardSpec} vocabulary and gets back a compiled Adaptive Card
 * document. Unlike `send_email`, building a card is a pure, side-effect-free
 * transform - nothing leaves the building - so it is NOT approval-gated: the
 * card is data the app then decides what to do with (render it in a preview,
 * post it to a Teams incoming webhook, attach it to a bot reply).
 *
 * The build runs through the executor the plugin installs on the shared
 * runtime, so a build from this tool picks up the same telemetry / timeout
 * chain as one from the AppKit tool. In a Mastra app with no AppKit plugin
 * registered the build still runs, just without interceptors.
 *
 * @module
 */

import { log, string } from "@dbx-tools/shared-core";
import { card } from "@dbx-tools/shared-teams";
import { createTool } from "@mastra/core/tools";
import { buildCard } from "./runtime.ts";

const logger = log.logger("teams/tool/create-card");

/**
 * The model-facing description of the card-building capability, shared by the
 * Mastra {@link teamsCardTool} and the AppKit `teams.createCard` tool so both
 * agents get the same guidance about the vocabulary and when to reach for it.
 */
export const CREATE_CARD_DESCRIPTION = string.toDescription(`
  Build a Microsoft Teams Adaptive Card from a short structured description.
  Provide a title, an optional subtitle and body text, an optional list of
  key/value facts, and optional link buttons; the tool returns a compiled
  Adaptive Card document (Adaptive Card 1.5) ready to render or post to Teams.
  Use it when the user asks to summarize a status, result, or record as a Teams
  card / message card, or to prepare something to post to a channel. Keep body
  text to the Teams Markdown subset - **bold**, _italic_, links, and '-'
  bullet lists - and put tabular key/value detail in the 'facts' array, not in
  the text. Do NOT hand-author raw Adaptive Card JSON; describe the card and
  this tool compiles the valid document.
`);

/** Options accepted by {@link teamsCardTool}. */
export interface TeamsCardToolOptions {
  /**
   * Override the tool id. Defaults to `"create_teams_card"`. A UI that renders
   * the returned card keys off this id, so keep it unless you also teach the
   * client about the new name.
   */
  id?: string;
}

/**
 * Build the `create_teams_card` tool. Spread it into the agents that should be
 * able to produce Teams cards.
 *
 * @example
 * ```ts
 * import { teamsCardTool } from "@dbx-tools/teams";
 * import { createAgent } from "@dbx-tools/appkit-mastra";
 *
 * const support = createAgent({
 *   instructions: "...",
 *   tools: () => ({ create_teams_card: teamsCardTool() }),
 * });
 * ```
 */
export function teamsCardTool(opts: TeamsCardToolOptions = {}) {
  return createTool({
    id: opts.id ?? "create_teams_card",
    description: CREATE_CARD_DESCRIPTION,
    inputSchema: card.cardSpecSchema,
    outputSchema: card.cardResultSchema,
    execute: async (input, context) => {
      const spec = card.cardSpecSchema.parse(input);
      const result = await buildCard(spec, context?.abortSignal);
      logger.info("built", {
        title: result.title,
        elements: result.card.body.length,
        actions: result.card.actions?.length ?? 0,
      });
      return result;
    },
  });
}
