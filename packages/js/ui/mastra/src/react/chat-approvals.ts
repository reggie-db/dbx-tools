import { log } from "@dbx-tools/shared-core";
import { useCallback } from "react";
import type { ThreadSessionReader, ThreadSessionUpdater } from "./chat-sessions.ts";
import type { ApprovalDecision } from "./types.ts";
import type { MastraPluginClient, MastraStreamResponse } from "../support/mastra-client.ts";
import { DEFAULT_THREAD_SESSION_KEY, type ThreadSession } from "../support/thread-sessions.ts";

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

/** Resolve one approval against the exact run and assistant message that created it. */
export function resolveApprovalContinuation(
  session: ThreadSession,
  decision: ApprovalDecision,
):
  | {
      assistantId: string;
      runId: string;
      requestContext: ThreadSession["runRequestContext"];
    }
  | undefined {
  const runId = decision.runId ?? session.runId;
  if (!runId) return undefined;
  const run = session.runs[runId];
  const assistantId =
    decision.messageId ??
    run?.assistantId ??
    Object.entries(session.pendingApprovalsByMessage).find(([, approvals]) =>
      approvals.some((approval) => approval.toolCallId === decision.toolCallId),
    )?.[0] ??
    session.assistantId;
  if (!assistantId) return undefined;
  return {
    assistantId,
    runId,
    requestContext: run?.requestContext,
  };
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
      const { toolCallId, toolName } = decision;
      const session = getSession(activeKey);
      const continuation = resolveApprovalContinuation(session, decision);
      if (!continuation) {
        logger.warn("approval missing runId or assistantId, cannot resume", {
          tool: toolName,
          toolCallId,
          hasRunId: Boolean(decision.runId ?? session.runId),
          hasAssistantId: Boolean(decision.messageId ?? session.assistantId),
        });
        return;
      }
      const { assistantId, runId, requestContext } = continuation;

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
              requestContext,
              signal,
            })
          : mastraClient.declineToolCallStream(agentId, {
              runId,
              toolCallId,
              threadId: streamThreadId,
              reason: decision.reason,
              requestContext,
              signal,
            }),
      );
    },
    [activeKey, agentId, driveStream, getSession, mastraClient, updateSession],
  );
}
