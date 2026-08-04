/**
 * Bot Framework Connector API client - how a reply actually reaches Teams.
 *
 * This is the part that makes the difference between a chat API and a bot. Azure
 * Bot Service does NOT read replies from the body of the `/messages` response:
 * it expects `200` (an acknowledgement that the activity was accepted) and then
 * a separate, authenticated call back to the `serviceUrl` the activity arrived
 * with. So a turn is inherently asynchronous - acknowledge, think, then deliver.
 *
 * Two calls are modelled, both `POST` to the conversation's activity collection:
 *
 *   - {@link sendActivity} - `POST /v3/conversations/{id}/activities/{replyToId}`
 *     delivers a reply threaded under the user's message.
 *   - {@link sendTyping} - the same call with a `typing` activity, which is what
 *     puts the "…" indicator in the channel while the agent works.
 *
 * `serviceUrl` is always supplied by the CALLER from a validated source (see
 * `isAllowedServiceUrl`), never read straight off an untrusted request body:
 * these calls carry the bot's bearer token, so the destination host is a
 * security-relevant input.
 *
 * @module
 */

import { log } from "@dbx-tools/shared-core";
import type { activity as activityContract } from "@dbx-tools/shared-teams";

const logger = log.logger("teams:connector");

/** Everything needed to address one Connector call. */
export interface ConnectorTarget {
  /** Base URL the activity arrived from, e.g. `https://smba.trafficmanager.net/amer/`. */
  serviceUrl: string;
  /** Conversation the reply belongs to. */
  conversationId: string;
  /** Bearer token for the bot's app registration. */
  token: string;
  /** Activity the reply threads under, when replying to a specific message. */
  replyToId?: string;
  /** Cancels the request with the turn. */
  signal?: AbortSignal;
}

/**
 * Build the activities URL for a conversation.
 *
 * `replyToId` selects the threaded form, which is what makes a reply appear
 * attached to the user's message rather than as a loose channel post.
 */
const activitiesUrl = (target: ConnectorTarget): string => {
  const base = target.serviceUrl.replace(/\/+$/, "");
  const conversation = encodeURIComponent(target.conversationId);
  const suffix = target.replyToId ? `/${encodeURIComponent(target.replyToId)}` : "";
  return `${base}/v3/conversations/${conversation}/activities${suffix}`;
};

/**
 * Deliver one activity to a conversation through the Connector API.
 *
 * Returns the id the channel assigned the posted activity, when it reports one -
 * useful for a later update/delete, and for correlating logs with what a user
 * sees in the channel.
 */
export const sendActivity = async (
  activity: activityContract.Activity,
  target: ConnectorTarget,
): Promise<string | undefined> => {
  const response = await fetch(activitiesUrl(target), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify(activity),
    ...(target.signal ? { signal: target.signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`teams: connector rejected the activity (${response.status}) ${detail}`.trim());
  }
  const payload = (await response.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  logger.debug("activity delivered", { conversation: target.conversationId, id });
  return id;
};

/**
 * Show the typing indicator in the conversation.
 *
 * Best-effort by design: a failed indicator must never fail the turn, because
 * the card that follows is the actual answer. A failure is logged at debug and
 * swallowed.
 */
export const sendTyping = async (target: ConnectorTarget): Promise<void> => {
  try {
    await sendActivity({ type: "typing" }, target);
  } catch (err) {
    logger.debug("typing indicator failed", {
      conversation: target.conversationId,
      error: (err as Error).message,
    });
  }
};
