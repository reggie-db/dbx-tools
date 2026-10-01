/**
 * AppKit evaluation driver for an in-process Mastra agent.
 *
 * @module
 */

import type { DriveResult, EvalDriver } from "@databricks/appkit/beta";
import { errorUtils, hash, object } from "@dbx-tools/shared-core";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";

import { createRequestContext } from "./server.ts";

/** Configuration for an in-process Mastra evaluation driver. */
export interface MastraEvalDriverOptions {
  /** Stable memory resource used by every turn from this driver. */
  resourceId?: string;
  /** Override request-context construction for isolated evaluation environments. */
  createRequestContext?: (options: {
    threadId: string;
    resourceId: string;
  }) => Promise<RequestContext>;
}

/** Drive AppKit evaluations through Mastra without reducing a chat stream. */
export function createMastraEvalDriver(
  agent: Agent,
  options: MastraEvalDriverOptions = {},
): EvalDriver {
  const resourceId = options.resourceId ?? `eval:${agent.id}`;
  const requestContextFactory = options.createRequestContext ?? createRequestContext;
  let threadId = hash.id();

  return {
    async send(message, sendOptions): Promise<DriveResult> {
      try {
        const requestContext = await requestContextFactory({ threadId, resourceId });
        const result = await agent.generate(message, {
          requestContext,
          memory: { thread: threadId, resource: resourceId },
          ...(sendOptions?.signal ? { abortSignal: sendOptions.signal } : {}),
        });
        const toolCallDetails = result.toolCalls.map((call) => {
          const payload: Record<string, unknown> = object.isRecord(call.payload)
            ? call.payload
            : {};
          const args = payload.args;
          return {
            name: String(payload.toolName ?? ""),
            args: object.isRecord(args) ? args : {},
          };
        });
        return {
          reply: result.text,
          toolCalls: toolCallDetails.map(({ name }) => name),
          toolCallDetails,
          succeeded: result.error === undefined && result.suspendPayload === undefined,
          sessionId: threadId,
          ...(result.traceId ? { traceId: result.traceId } : {}),
        };
      } catch (caught) {
        return {
          reply: errorUtils.errorMessage(caught),
          toolCalls: [],
          toolCallDetails: [],
          succeeded: false,
          sessionId: threadId,
        };
      }
    },
    reset() {
      threadId = hash.id();
    },
  };
}
