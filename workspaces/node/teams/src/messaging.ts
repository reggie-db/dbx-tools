/**
 * The Teams messaging endpoint's turn: what happens between Azure Bot Service
 * POSTing an activity and a card appearing in the channel.
 *
 * Split out from `conversation.ts` because the two callers have genuinely
 * different contracts. `conversation.ts` runs a turn and RETURNS the reply, which
 * is what a direct HTTP caller (or the in-repo preview UI) wants. A real channel
 * cannot work that way: Bot Service ignores the response body and expects a fast
 * `200`, so this module acknowledges first and delivers the reply out-of-band
 * through the Connector API.
 *
 * The sequence for a `message` activity:
 *
 *   1. validate the inbound JWT and pin the reply destination to the
 *      token's `serviceUrl` (see `auth.ts`);
 *   2. return `200` immediately - Bot Service retries an activity it thinks
 *      timed out, and a duplicate turn means a duplicate card;
 *   3. show the typing indicator, run the agent, and POST the card back.
 *
 * Step 2 is why this is fire-and-forget rather than awaited: a card-producing
 * agent turn takes seconds to tens of seconds, far longer than the ~15s Bot
 * Service allows a bot to acknowledge.
 *
 * @module
 */

import { error, log } from "@dbx-tools/shared-core";
import { activity as activityContract } from "@dbx-tools/shared-teams";
import { connectorToken, isAllowedServiceUrl } from "./auth";
import { sendActivity, sendTyping } from "./connector";
import { runCardTurn, type CardAgentLike, type CardContextFactory } from "./conversation";

const logger = log.logger("teams:messaging");

/**
 * Message shown in the channel when a turn fails.
 *
 * A bot that silently drops a failed turn looks broken - the user sees their
 * message land and nothing come back, forever. A short apology is posted instead
 * so the conversation stays legible; the real error goes to the logs.
 */
const FAILURE_TEXT = "Sorry - I could not put together an answer for that. Please try again.";

/** Resolved bot credentials a delivered turn needs. */
export interface BotCredentials {
  /** Entra app (client) id of the bot registration. */
  appId: string;
  /** Client secret for {@link appId}. */
  appPassword: string;
  /** Tenant id for a single-tenant bot. */
  appTenantId?: string;
}

/** Everything {@link deliverTurn} needs to answer one inbound activity. */
export interface DeliverTurnOptions {
  /** The agent that composes the card. */
  agent: CardAgentLike;
  /** The validated inbound activity. */
  activity: activityContract.Activity;
  /** Bot credentials used to fetch the outbound Connector token. */
  credentials: BotCredentials;
  /**
   * Reply destination, already validated against the inbound token. Passing this
   * explicitly (rather than reading `activity.serviceUrl`) keeps the security
   * decision in the caller, where the token is in scope.
   */
  serviceUrl: string;
  /**
   * Builds the agent's per-turn request context, so the delivered turn has the
   * same tool reach (Genie and every other user-scoped tool) as a chat turn.
   */
  createRequestContext?: CardContextFactory;
  /** Cancels the turn (process shutdown, or a test tearing down). */
  signal?: AbortSignal;
}

/**
 * Read the reply destination off an inbound activity, if it names a usable one.
 *
 * `serviceUrl` rides on the activity as a plain string, so it is validated
 * against the verified token's own `serviceurl` claim before anything
 * authenticated is sent there.
 */
export const resolveServiceUrl = (
  activity: activityContract.Activity,
  tokenServiceUrl?: string,
): string | null => {
  const raw = (activity as { serviceUrl?: unknown }).serviceUrl;
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (!candidate) return null;
  return isAllowedServiceUrl(candidate, tokenServiceUrl) ? candidate : null;
};

/**
 * Run one turn and deliver the card back through the Connector API.
 *
 * Awaited by nobody on the request path (the route has already answered `200`),
 * so this owns its own error handling: a failure posts {@link FAILURE_TEXT} to
 * the channel and is logged, never rethrown into an unhandled rejection.
 */
export const deliverTurn = async (options: DeliverTurnOptions): Promise<void> => {
  const { agent, activity, credentials, serviceUrl } = options;
  const conversationId = activity.conversation?.id;
  if (!conversationId) {
    logger.warn("dropping activity with no conversation id");
    return;
  }

  const base = {
    serviceUrl,
    conversationId,
    ...(activity.id ? { replyToId: activity.id } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let token: string;
  try {
    token = await connectorToken({
      appId: credentials.appId,
      appPassword: credentials.appPassword,
      ...(credentials.appTenantId ? { appTenantId: credentials.appTenantId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    // No token means nothing can be delivered - not even the apology - so this
    // is the one failure that can only be logged.
    logger.error("could not obtain a connector token", { error: error.errorMessage(err) });
    return;
  }

  const target = { ...base, token };
  await sendTyping(target);

  try {
    const activities = await runCardTurn(agent, activity, {
      ...(options.createRequestContext
        ? { createRequestContext: options.createRequestContext }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for (const reply of activities) {
      await sendActivity(reply, target);
    }
    logger.info("turn delivered", { conversation: conversationId, replies: activities.length });
  } catch (err) {
    logger.error("turn failed", { conversation: conversationId, error: error.errorMessage(err) });
    try {
      await sendActivity({ type: "message", text: FAILURE_TEXT }, target);
    } catch (postErr) {
      logger.error("could not report the failure to the channel", {
        error: error.errorMessage(postErr),
      });
    }
  }
};
