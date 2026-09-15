import { error as sharedError, log } from "@dbx-tools/shared-core";
import type { UIMessage } from "ai";
import { useCallback, useRef } from "react";
import type { MastraPluginClient } from "../support/mastra-client.ts";
import type { FeedbackSubmission, MessageFeedback } from "./types.ts";
import type { ThreadSessionUpdater } from "./chat-sessions.ts";

const logger = log.logger("ui-mastra/chat");

interface UseChatFeedbackOptions {
  activeKey: string;
  feedbackByMessage: Record<string, MessageFeedback>;
  mastraClient: MastraPluginClient;
  updateSession: ThreadSessionUpdater;
}

/** Submit trace-scoped MLflow feedback with optimistic thumbs state. */
export function useChatFeedback({
  activeKey,
  feedbackByMessage,
  mastraClient,
  updateSession,
}: UseChatFeedbackOptions) {
  const feedbackByMessageRef = useRef<Record<string, MessageFeedback>>({});
  feedbackByMessageRef.current = feedbackByMessage;

  return useCallback(
    async (message: UIMessage, submission: FeedbackSubmission) => {
      const traceId = feedbackByMessageRef.current[message.id]?.traceId;
      if (!traceId) return;
      if (submission.value) {
        updateSession(activeKey, (session) => ({
          ...session,
          feedbackByMessage: {
            ...session.feedbackByMessage,
            [message.id]: { traceId, value: submission.value },
          },
        }));
      }
      try {
        const result = await mastraClient.feedback({
          traceId,
          ...(submission.value !== undefined ? { value: submission.value === "up" } : {}),
          ...(submission.comment ? { comment: submission.comment } : {}),
        });
        if (!result.ok) {
          logger.warn("feedback not recorded (trace may still be exporting)", {
            traceId,
          });
        }
      } catch (error) {
        logger.error("feedback error", {
          traceId,
          error: sharedError.errorMessage(error),
        });
      }
    },
    [activeKey, mastraClient, updateSession],
  );
}
