import { log } from "@dbx-tools/shared-core";
import { useCallback } from "react";
import type { MastraPluginClient } from "../support/mastra-client.ts";
import type { MastraStreamResponse } from "../support/mastra-stream.ts";
import { DEFAULT_THREAD_SESSION_KEY } from "../support/thread-sessions.ts";
import type { ThreadSessionReader, ThreadSessionUpdater } from "./chat-sessions.ts";
import type { ApprovalDecision } from "./types.ts";

const logger = log.logger("ui-mastra/chat");

type ChatStreamDriver = (
  threadId: string,
  assistantId: string,
  open: (signal: AbortSignal) => Promise<MastraStreamResponse>,
) => Promise<void>;

interface UseChatApprovalsOptions {
  activeKey: string;
  agentId: string;
  driveStream: ChatStreamDriver;
  getSession: ThreadSessionReader;
  mastraClient: MastraPluginClient;
  updateSession: ThreadSessionUpdater;
}

/** Resume an approval-gated tool call and remove its pending UI state. */
export function useChatApprovals({
  activeKey,
  agentId,
  driveStream,
  getSession,
  mastraClient,
  updateSession,
}: UseChatApprovalsOptions) {
  return useCallback(
    async (decision: ApprovalDecision) => {
      const { runId: decisionRunId, toolCallId, toolName } = decision;
      const session = getSession(activeKey);
      const assistantId = session.assistantId;
      const runId = decisionRunId ?? session.runId;
      if (!runId || !assistantId) {
        logger.warn("approval missing runId or assistantId, cannot resume", {
          tool: toolName,
          toolCallId,
          hasRunId: Boolean(runId),
          hasAssistantId: Boolean(assistantId),
        });
        return;
      }

      updateSession(activeKey, (current) => {
        const existing = current.pendingApprovalsByMessage[assistantId];
        if (!existing) return current;
        const next = existing.filter((approval) => approval.toolCallId !== toolCallId);
        if (next.length === 0) {
          const { [assistantId]: _drop, ...rest } = current.pendingApprovalsByMessage;
          return { ...current, pendingApprovalsByMessage: rest };
        }
        return {
          ...current,
          pendingApprovalsByMessage: {
            ...current.pendingApprovalsByMessage,
            [assistantId]: next,
          },
        };
      });

      logger.info(decision.approved ? "approved" : "denied", {
        tool: toolName,
        toolCallId,
        runId,
      });
      const streamThreadId = activeKey === DEFAULT_THREAD_SESSION_KEY ? undefined : activeKey;
      await driveStream(activeKey, assistantId, (signal) =>
        decision.approved
          ? mastraClient.approveToolCallStream(agentId, {
              runId,
              toolCallId,
              threadId: streamThreadId,
              signal,
            })
          : mastraClient.declineToolCallStream(agentId, {
              runId,
              toolCallId,
              threadId: streamThreadId,
              signal,
            }),
      );
    },
    [activeKey, agentId, driveStream, getSession, mastraClient, updateSession],
  );
}
