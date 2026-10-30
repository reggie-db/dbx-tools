import { log, toError } from "@dbx-tools/shared-core";
import { GenieMessageSchema } from "@dbx-tools/shared-genie";
import type { FeedbackDestination } from "@dbx-tools/shared-mastra";
import type { UIMessage } from "ai";
import { useCallback, useRef } from "react";
import type { ThreadSessionUpdater } from "./chat-sessions.ts";
import type { FeedbackSubmission, MessageFeedback } from "./types.ts";
import type { MastraPluginClient } from "../support/mastra-client.ts";
import { toolEventsFromParts } from "../support/tool-events.ts";

const logger = log.logger("ui-mastra/chat");

interface UseChatFeedbackOptions {
  activeKey: string;
  feedbackByMessage: Record<string, MessageFeedback>;
  feedbackModes: readonly FeedbackDestination[];
  mastraClient: MastraPluginClient;
  updateSession: ThreadSessionUpdater;
}

/** Genie message target recovered from one completed ask_genie tool result. */
export interface GenieFeedbackTarget {
  spaceId: string;
  conversationId: string;
  messageId: string;
}

/** Per-message feedback destination and optional Genie identity. */
export type MessageFeedbackDestination =
  | { mode: "mlflow"; traceId: string }
  | ({ mode: "genie" } & GenieFeedbackTarget);

/** Read the latest Genie target from an assistant message's tool results. */
export function genieFeedbackTarget(message: UIMessage): GenieFeedbackTarget | undefined {
  for (const event of [...toolEventsFromParts(message.parts)].reverse()) {
    if (!event.toolName.startsWith("ask_genie")) continue;
    const output =
      typeof event.output === "object" && event.output !== null && "message" in event.output
        ? event.output.message
        : undefined;
    const parsed = GenieMessageSchema.safeParse(output);
    if (!parsed.success) continue;
    const genieMessage = parsed.data;
    const messageId = genieMessage.message_id ?? genieMessage.id;
    if (genieMessage.space_id && genieMessage.conversation_id && messageId) {
      return {
        spaceId: genieMessage.space_id,
        conversationId: genieMessage.conversation_id,
        messageId,
      };
    }
  }
  return undefined;
}

/** Select Genie for a Genie result, otherwise MLflow for a traced response. */
export function messageFeedbackDestination(
  message: UIMessage,
  feedbackModes: readonly FeedbackDestination[],
  traceId?: string,
): MessageFeedbackDestination | undefined {
  const genieTarget = feedbackModes.includes("genie") ? genieFeedbackTarget(message) : undefined;
  if (genieTarget) return { mode: "genie", ...genieTarget };
  if (traceId && feedbackModes.includes("mlflow")) return { mode: "mlflow", traceId };
  return undefined;
}

/** Submit feedback to the destination selected for the assistant message. */
export function useChatFeedback({
  activeKey,
  feedbackByMessage,
  feedbackModes,
  mastraClient,
  updateSession,
}: UseChatFeedbackOptions) {
  const feedbackByMessageRef = useRef<Record<string, MessageFeedback>>({});
  feedbackByMessageRef.current = feedbackByMessage;

  return useCallback(
    async (message: UIMessage, submission: FeedbackSubmission) => {
      const traceId = feedbackByMessageRef.current[message.id]?.traceId;
      const destination = messageFeedbackDestination(message, feedbackModes, traceId);
      if (!destination) return;

      if (submission.value) {
        updateSession(activeKey, (session) => ({
          ...session,
          feedbackByMessage: {
            ...session.feedbackByMessage,
            [message.id]: {
              ...(traceId ? { traceId } : {}),
              value: submission.value,
            },
          },
        }));
      }
      try {
        let result;
        if (destination.mode === "genie") {
          if (!submission.value || !submission.request) return;
          result = await mastraClient.feedback({
            mode: "genie",
            spaceId: destination.spaceId,
            conversationId: destination.conversationId,
            messageId: destination.messageId,
            rating: submission.value === "up" ? "POSITIVE" : "NEGATIVE",
            request: submission.request,
            ...(submission.comment ? { comment: submission.comment } : {}),
          });
        } else {
          result = await mastraClient.feedback({
            mode: "mlflow",
            traceId: destination.traceId,
            ...(submission.value !== undefined ? { value: submission.value === "up" } : {}),
            ...(submission.comment ? { comment: submission.comment } : {}),
          });
        }
        if (!result.ok) {
          logger.warn("feedback not recorded", {
            feedbackMode: destination.mode,
            ...(traceId ? { traceId } : {}),
          });
        }
      } catch (error) {
        logger.error("feedback error", {
          feedbackMode: destination.mode,
          ...(traceId ? { traceId } : {}),
          error: toError(error),
        });
      }
    },
    [activeKey, feedbackModes, mastraClient, updateSession],
  );
}
