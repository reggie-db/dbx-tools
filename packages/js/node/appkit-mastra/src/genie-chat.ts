/**
 * Direct Genie chat over the Mastra chat wire.
 *
 * Serves one Genie space as a chat without an agent, model, or Mastra Memory.
 * Genie owns every piece of state: conversations are the chat threads, Genie
 * messages are the transcript, and a turn is one Genie message. Each turn is
 * projected onto the same AI SDK UI chunks an agent turn produces when it
 * calls `ask_genie` (a native tool part, `data-genie-progress` events, and the
 * answer text), so the Mastra chat UI renders pills, thoughts, suggestions,
 * and embeds identically for both.
 *
 * @module
 */

import type { WorkspaceClient } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { agentMode, chat } from "@dbx-tools/genie";
import { errorUtils, hash, log, object } from "@dbx-tools/shared-core";
import { event as genieEvent, genieModel, type GenieMessage } from "@dbx-tools/shared-genie";
import {
  markers,
  wire,
  type GenieChatRequest,
  type GenieThread,
  type StartedEvent,
} from "@dbx-tools/shared-mastra";
import { createUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

import { askGenieToolId } from "./genie.ts";

const logger = log.logger("mastra/genie-chat");

/** Page size used while walking Genie's paginated list endpoints. */
const LIST_PAGE_SIZE = 100;

/** Upper bound on conversations surfaced in the thread list. */
const THREAD_LIMIT = 100;
const AGENT_CONVERSATION_TYPE = "GENIE_CONVERSATION_TYPE_AGENT";
const DIRECT_GENIE_ERROR = "Genie could not complete the request.";

/** Suffix that keeps a Genie question's user message id distinct from its answer. */
const QUESTION_ID_SUFFIX = ":question";

/** One configured Genie space addressed by the direct chat routes. */
export interface GenieChatSpace {
  /** Space alias from the route, which also selects the `ask_genie` tool id. */
  alias: string;
  /** Genie `space_id`. */
  spaceId: string;
}

/**
 * Compose the visible answer for one terminal Genie message: its narrative text
 * first, then one embed per query that produced a warehouse statement. A query
 * Genie chose to visualize embeds `[visualization:<statement_id>]`, which
 * AppKit UI renders with its native Genie visualization. Any other query embeds
 * `[data:<statement_id>]`. Agent Mode's Markdown copy of a query result is
 * dropped because either embed renders the same rows.
 */
export function genieAnswerText(message: GenieMessage): string {
  const attachments = message.attachments ?? [];
  const visualizedQueries = new Set(
    attachments.flatMap((attachment) =>
      attachment.viz?.query_attachment_id ? [attachment.viz.query_attachment_id] : [],
    ),
  );
  const prose: string[] = [];
  const embeds: string[] = [];
  for (const attachment of attachments) {
    const text = attachment.text?.content?.trim();
    if (text && !isQueryOutputText(attachment.text?.metadata)) prose.push(text);
    const statementId = attachment.query?.statement_id;
    if (!statementId) continue;
    const description = attachment.query?.description?.trim();
    if (description) embeds.push(description);
    embeds.push(
      visualizedQueries.has(attachment.attachment_id ?? "")
        ? markers.formatMarker("visualization", statementId)
        : markers.formatMarker("data", statementId),
    );
  }
  const sections = [...prose, ...embeds];
  if (sections.length === 0 && message.error?.error) sections.push(message.error.error);
  return sections.join("\n\n");
}

/** Whether a text attachment is Agent Mode's Markdown copy of a query result. */
function isQueryOutputText(metadata: unknown): boolean {
  return object.isRecord(metadata) && typeof metadata.statement_id === "string";
}

/** Error text for a terminal Genie message that did not complete, or `undefined`. */
function genieFailure(message: GenieMessage): string | undefined {
  if (message.status === "COMPLETED") return undefined;
  return message.error?.error ?? `Genie ${genieModel.humanizeStatus(message.status!)}`;
}

/**
 * Project one persisted Genie message onto the user question and the assistant
 * answer the chat transcript renders. The assistant owns an `ask_genie` tool
 * part whose progress is re-derived from the terminal snapshot, so reloaded
 * history shows the same pill, SQL, and suggestions as the live turn.
 */
export function genieMessageToUiMessages(
  message: GenieMessage,
  space: GenieChatSpace,
): UIMessage[] {
  const messageId = message.message_id || message.id;
  const toolCallId = messageId;
  const input = { question: message.content };
  const failure = genieFailure(message);
  const progress = [...genieEvent.eventsFromMessage(message, undefined, space.spaceId)].map(
    (progressEvent) => ({
      type: wire.GENIE_PROGRESS_PART_TYPE,
      data: { toolCallId, event: progressEvent },
    }),
  );
  const toolPart = failure
    ? {
        type: `tool-${askGenieToolId(space.alias)}`,
        toolCallId,
        state: "output-error",
        input,
        errorText: failure,
      }
    : {
        type: `tool-${askGenieToolId(space.alias)}`,
        toolCallId,
        state: "output-available",
        input,
        output: { message },
      };
  const answer = genieAnswerText(message);
  const assistantParts = [
    toolPart,
    ...progress,
    ...(answer ? [{ type: "text", text: answer, state: "done" }] : []),
  ] as UIMessage["parts"];
  return [
    {
      id: `${messageId}${QUESTION_ID_SUFFIX}`,
      role: "user",
      parts: [{ type: "text", text: message.content }],
    },
    { id: messageId, role: "assistant", parts: assistantParts },
  ];
}

/** List the caller's conversations in one space, newest first. */
export async function listGenieThreads(
  client: WorkspaceClient,
  space: GenieChatSpace,
  signal?: AbortSignal,
): Promise<GenieThread[]> {
  const context = signal ? databricks.toContext(signal) : undefined;
  const threads: GenieThread[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.genie.listConversations(
      {
        space_id: space.spaceId,
        page_size: LIST_PAGE_SIZE,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      context,
    );
    for (const conversation of page.conversations ?? []) {
      if (!object.isRecord(conversation) || conversation.agent_type !== AGENT_CONVERSATION_TYPE) {
        continue;
      }
      threads.push({
        id: conversation.conversation_id,
        ...(conversation.title ? { title: conversation.title } : {}),
        createdAt: new Date(conversation.created_timestamp).toISOString(),
      });
    }
    pageToken = page.next_page_token || undefined;
  } while (pageToken && threads.length < THREAD_LIMIT);
  return threads.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, THREAD_LIMIT);
}

/**
 * Load one conversation's messages as chronological chat transcript messages.
 * Conversation items come only from the Agent Mode items API, which retains
 * user messages, reasoning, queries, results, reports, and final answers.
 */
export async function listGenieThreadMessages(options: {
  client: WorkspaceClient;
  space: GenieChatSpace;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<UIMessage[]> {
  const { space } = options;
  const messages = await agentMode.listAgentModeConversation(
    options.client,
    space.spaceId,
    options.conversationId,
    {
      ...(options.signal ? { context: options.signal } : {}),
    },
  );
  return messages.flatMap((message) => genieMessageToUiMessages(message, space));
}

/**
 * Stream one Genie turn as AI SDK UI chunks shaped like an agent's
 * `ask_genie` call. The conversation identity is announced through a transient
 * {@link wire.GENIE_CONVERSATION_PART_TYPE} part as soon as Genie assigns it,
 * so the browser can adopt the conversation id as its thread id. Agent Mode
 * receives Genie's native visualization tool; visualization attachments become
 * AppKit UI embed markers in the answer.
 */
export function genieChatStream(options: {
  client: WorkspaceClient;
  space: GenieChatSpace;
  request: GenieChatRequest;
  signal?: AbortSignal;
}): ReadableStream<UIMessageChunk> {
  const { client, space, request, signal } = options;
  const toolCallId = hash.id();
  const toolName = askGenieToolId(space.alias);
  return createUIMessageStream({
    onError: () => DIRECT_GENIE_ERROR,
    execute: async ({ writer }) => {
      const progress = (progressEvent: wire.GenieWriterEvent) =>
        writer.write({
          type: wire.GENIE_PROGRESS_PART_TYPE,
          data: { toolCallId, event: progressEvent },
        });
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      writer.write({
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: { question: request.question },
      });
      const started: StartedEvent = {
        type: "started",
        spaceId: space.spaceId,
        content: request.question,
      };
      progress(started);

      let announced: wire.GenieConversationPartData | undefined;
      let finalMessage: GenieMessage | undefined;
      try {
        for await (const chatEvent of chat.genieEventChat(space.spaceId, request.question, {
          workspaceClient: client,
          agentMode: true,
          agentModeFallback: false,
          enableVisualization: true,
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          ...(signal ? { context: signal } : {}),
        })) {
          const conversationId = chatEvent.conversation_id ?? request.conversationId;
          const messageId = chatEvent.message_id;
          // Re-announce only when the identity gains information (the message
          // id commonly lands one snapshot after the conversation id).
          if (
            conversationId &&
            (announced?.conversationId !== conversationId ||
              (messageId && announced.messageId !== messageId))
          ) {
            announced = { conversationId, ...(messageId ? { messageId } : {}) };
            writer.write({
              type: wire.GENIE_CONVERSATION_PART_TYPE,
              data: announced,
              transient: true,
            });
          }
          if (chatEvent.type === "result") finalMessage = chatEvent.message;
          else if (chatEvent.type !== "message") progress(chatEvent);
        }
      } catch (error) {
        logger.warn("turn:error", {
          spaceId: space.spaceId,
          error: errorUtils.toError(error),
        });
        writer.write({
          type: "tool-output-error",
          toolCallId,
          errorText: DIRECT_GENIE_ERROR,
        });
        throw error;
      }
      if (!finalMessage) throw new Error("Genie ended the turn without a result");

      const failure = genieFailure(finalMessage);
      writer.write(
        failure
          ? { type: "tool-output-error", toolCallId, errorText: failure }
          : { type: "tool-output-available", toolCallId, output: { message: finalMessage } },
      );
      writer.write({ type: "finish-step" });
      const answer = genieAnswerText(finalMessage);
      if (answer) {
        const textId = hash.id();
        writer.write({ type: "start-step" });
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: answer });
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "finish-step" });
      }
      writer.write({ type: "finish", finishReason: failure ? "error" : "stop" });
      logger.debug("turn:done", {
        spaceId: space.spaceId,
        conversationId: announced?.conversationId,
        status: finalMessage.status,
      });
    },
  });
}

/** Delete one Genie conversation owned by the caller. */
export async function deleteGenieThread(
  client: WorkspaceClient,
  space: GenieChatSpace,
  conversationId: string,
): Promise<void> {
  await client.genie.deleteConversation({
    space_id: space.spaceId,
    conversation_id: conversationId,
  });
}

/** Delete one Genie message, accepting either its answer or question transcript id. */
export async function deleteGenieThreadMessage(
  client: WorkspaceClient,
  space: GenieChatSpace,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await client.genie.deleteConversationMessage({
    space_id: space.spaceId,
    conversation_id: conversationId,
    message_id: messageId.endsWith(QUESTION_ID_SUFFIX)
      ? messageId.slice(0, -QUESTION_ID_SUFFIX.length)
      : messageId,
  });
}
