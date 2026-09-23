/**
 * Genie Agent Mode SSE transport.
 *
 * Streams the Responses-shaped Agent Mode API and projects its reasoning, SQL,
 * query output, and final answer items onto the existing `GenieMessage`
 * contract so callers can keep one semantic event pipeline across Agent Mode
 * and the legacy polling API.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { error, json, log, object } from "@dbx-tools/shared-core";
import {
  agentMode as agentModeWire,
  type GenieAgentModeEvent,
  type GenieMessage,
} from "@dbx-tools/shared-genie";

const logger = log.logger("genie/agent-mode");
const CANCEL_TIMEOUT_MS = 5_000;

/** Inputs for one Agent Mode response stream. */
export interface GenieAgentModeOptions {
  conversationId?: string;
  enableVisualization?: boolean;
  context?: databricks.ContextLike;
}

/** Stream one Agent Mode response as `GenieMessage` snapshots. */
export async function* genieAgentModeChat(
  client: WorkspaceClient,
  agentId: string,
  content: string,
  options: GenieAgentModeOptions = {},
): AsyncGenerator<GenieMessage, void, void> {
  const ownedController = options.context ? undefined : new AbortController();
  const projection = new agentModeWire.GenieAgentModeProjection(agentId, content);
  try {
    const context = options.context
      ? databricks.toContext(options.context)
      : databricks.toContext(ownedController!);
    const response = await client.apiClient.request(
      {
        path: `/api/2.0/genie/agents/${encodeURIComponent(agentId)}/responses`,
        method: "POST",
        headers: new Headers({
          accept: "text/event-stream",
          "content-type": "application/json",
        }),
        raw: true,
        payload: {
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: content }],
            },
          ],
          ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
          ...(options.enableVisualization ? { enable_viz: true } : {}),
        },
      },
      context,
    );
    const stream = object.isRecord(response) ? response.contents : undefined;
    if (!isReadableStream(stream)) {
      throw new TypeError("Genie Agent Mode did not return an SSE stream");
    }

    let previous: GenieMessage | undefined;
    for await (const event of parseSse(stream)) {
      const message = projection.apply(event);
      if (!message) continue;
      if (!object.deepEqual(message, previous)) {
        yield message;
        previous = message;
      }
    }
    if (!projection.terminal) {
      throw new Error("Genie Agent Mode stream ended before a terminal response");
    }
  } finally {
    ownedController?.abort();
    if (!projection.terminal && projection.responseId && projection.conversationId) {
      await cancelResponse(client, agentId, projection.conversationId, projection.responseId);
    }
  }
}

/** Return whether Agent Mode is disabled or its preview toggle is unavailable. */
export function isAgentModeUnavailable(value: unknown): boolean {
  const context = error.errorContext(value);
  return context.hasMessage("feature", "disabled") || context.hasMessage("preview", "toggle");
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return object.isRecord(value) && typeof value.getReader === "function";
}

async function cancelResponse(
  client: WorkspaceClient,
  agentId: string,
  conversationId: string,
  responseId: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
  try {
    await client.apiClient.request(
      {
        path: `/api/2.0/genie/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/responses/${encodeURIComponent(responseId)}/cancel`,
        method: "POST",
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
        }),
        raw: false,
      },
      databricks.toContext(controller),
    );
  } catch (err) {
    logger.debug("response:cancel-failed", {
      agentId,
      conversationId,
      responseId,
      error: error.errorMessage(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<GenieAgentModeEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event) yield event;
      }
      if (done) {
        const event = parseSseFrame(buffer);
        if (event) yield event;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): GenieAgentModeEvent | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  return agentModeWire.GenieAgentModeEventSchema.parse(json.parse(data));
}
