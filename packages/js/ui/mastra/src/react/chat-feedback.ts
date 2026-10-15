import { errorUtils, log } from "@dbx-tools/shared-core";
import { genieModel } from "@dbx-tools/shared-genie";
import type { FeedbackMode } from "@dbx-tools/shared-mastra/feedback";
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
  feedbackMode: FeedbackMode;
  mastraClient: MastraPluginClient;
  updateSession: ThreadSessionUpdater;
}

/** Genie message target recovered from one completed ask_genie tool result. */
export interface GenieFeedbackTarget {
  spaceId: string;
  conversationId: string;
  messageId: string;
}

/** Read the latest Genie target from an assistant message's tool results. */
export function genieFeedbackTarget(message: UIMessage): GenieFeedbackTarget | undefined {
  for (const event of [...toolEventsFromParts(message.parts)].reverse()) {
    if (!event.toolName.startsWith("ask_genie")) continue;
    const output =
      typeof event.output === "object" && event.output !== null && "message" in event.output
        ? event.output.message
        : undefined;
    const parsed = genieModel.GenieMessageSchema.safeParse(output);
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

/** Submit feedback to the single destination selected by the server. */
export function useChatFeedback({
  activeKey,
  feedbackByMessage,
  feedbackMode,
  mastraClient,
  updateSession,
}: UseChatFeedbackOptions) {
  const feedbackByMessageRef = useRef<Record<string, MessageFeedback>>({});
  feedbackByMessageRef.current = feedbackByMessage;

  return useCallback(
    async (message: UIMessage, submission: FeedbackSubmission) => {
      const traceId = feedbackByMessageRef.current[message.id]?.traceId;
      const target = feedbackMode === "genie" ? genieFeedbackTarget(message) : undefined;
      if (feedbackMode === "none") return;

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
        if (feedbackMode === "genie") {
          if (!target || !submission.value || !submission.request) return;
          result = await mastraClient.feedback({
            mode: "genie",
            ...target,
            rating: submission.value === "up" ? "POSITIVE" : "NEGATIVE",
            request: submission.request,
            ...(submission.comment ? { comment: submission.comment } : {}),
          });
        } else {
          if (!traceId) return;
          result = await mastraClient.feedback({
            mode: "mlflow",
            traceId,
            ...(submission.value !== undefined ? { value: submission.value === "up" } : {}),
            ...(submission.comment ? { comment: submission.comment } : {}),
          });
        }
        if (!result.ok) {
          logger.warn("feedback not recorded", {
            feedbackMode,
            ...(traceId ? { traceId } : {}),
          });
        }
      } catch (error) {
        logger.error("feedback error", {
          feedbackMode,
          ...(traceId ? { traceId } : {}),
          error: errorUtils.toError(error),
        });
      }
    },
    [activeKey, feedbackMode, mastraClient, updateSession],
  );
}
