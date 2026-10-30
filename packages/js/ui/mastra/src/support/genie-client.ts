import {
  type MastraClientConfig,
  genieRoutePath,
  MASTRA_ROUTES,
  GENIE_CONVERSATION_PART_TYPE,
  GenieConversationPartDataSchema,
  MastraSuggestionsResponseSchema,
  GenieThreadsResponseSchema,
  GenieThreadMessagesResponseSchema,
} from "@dbx-tools/shared-mastra";
import type {
  ListAgentSuspendedRunsResponse,
  ListMemoryThreadMessagesResponse,
  ListMemoryThreadsResponse,
  RequestContext,
} from "@mastra/client-js";
import { validateUIMessages, type UIMessage, type UIMessageChunk } from "ai";
import { MastraPluginClient, type MastraStreamResponse } from "./mastra-client.ts";

/**
 * {@link MastraPluginClient} that talks to one Genie space directly through
 * the Mastra plugin's `/genie/:alias` routes instead of an outer agent. Genie
 * owns conversation state while the server may add Mastra request context and
 * resource-scoped memory. Its conversations are the threads (the conversation
 * id is the thread id), its messages are the history, and each turn streams
 * the same AI SDK chunks as an agent's `ask_genie` call, so the Mastra chat
 * renders it unchanged.
 *
 * A brand-new thread has no Genie conversation until its first turn; the
 * stream announces the conversation id, which {@link MastraStreamResponse.threadId}
 * reports so the chat adopts it.
 */
export class GenieChatClient extends MastraPluginClient {
  /** Genie space alias every route is scoped to. */
  readonly alias: string;
  override readonly backgroundTurns = false;
  override readonly feedbackModes: readonly "genie"[];
  override readonly threadRename = false;
  override readonly attachments = false;
  override readonly followUpSuggestions: "none" | "genie";
  /** Local and resolved thread ids mapped to their Genie conversation id. */
  readonly #conversationIds = new Map<string, string>();
  /** Transcript message id to Genie message id, for regenerate cleanup. */
  readonly #genieMessageIds = new Map<string, string>();

  constructor(config: MastraClientConfig, alias: string) {
    super(config);
    this.alias = alias;
    this.feedbackModes = config.feedbackModes?.includes("genie") ? ["genie"] : [];
    this.followUpSuggestions =
      config.followUpSuggestions === "genie" || config.followUpSuggestions === "auto"
        ? "genie"
        : "none";
  }

  #url(...parts: string[]): string {
    return `${this.basePath}${genieRoutePath(this.alias, ...parts)}`;
  }

  #rememberConversation(threadId: string | undefined, conversationId: string): void {
    this.#conversationIds.set(conversationId, conversationId);
    if (threadId) this.#conversationIds.set(threadId, conversationId);
  }

  #forgetConversation(conversationId: string): void {
    for (const [threadId, resolvedId] of this.#conversationIds) {
      if (resolvedId === conversationId) this.#conversationIds.delete(threadId);
    }
  }

  async #delete(url: string, signal?: AbortSignal): Promise<void> {
    const res = await fetch(url, {
      method: "DELETE",
      credentials: "include",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  }

  /** Stream one Genie turn, continuing the thread's conversation when it has one. */
  override async streamAgent(params: {
    messages: UIMessage[];
    runId: string;
    threadId?: string;
    requestContext?: RequestContext;
    signal?: AbortSignal;
  }): Promise<MastraStreamResponse> {
    const userMessage = [...params.messages].reverse().find((message) => message.role === "user");
    const question = (userMessage?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    const conversationId = params.threadId ? this.#conversationIds.get(params.threadId) : undefined;
    const response = await this.uiStream({
      path: this.#url(MASTRA_ROUTES.chat),
      chatId: params.threadId ?? params.runId,
      messages: userMessage ? [userMessage] : [],
      body: {
        question,
        ...(conversationId ? { conversationId } : {}),
        ...(params.requestContext ? { requestContext: params.requestContext } : {}),
      },
      routing: {},
      signal: params.signal,
    });
    let resolved: string | undefined;
    const stream = response.stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          if (chunk.type === GENIE_CONVERSATION_PART_TYPE) {
            const data = GenieConversationPartDataSchema.safeParse(chunk.data);
            if (data.success) {
              resolved = data.data.conversationId;
              this.#rememberConversation(params.threadId, resolved);
              if (userMessage && data.data.messageId) {
                this.#genieMessageIds.set(userMessage.id, data.data.messageId);
              }
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return { headers: response.headers, stream, threadId: () => resolved };
  }

  /** Genie turns are request-scoped; there is no background run to observe. */
  override async observeAgentStream(): Promise<MastraStreamResponse> {
    throw new Error("Direct Genie chat has no background runs");
  }

  /** Genie turns stop when their stream is aborted. */
  override async abortAgentRun(): Promise<boolean> {
    return false;
  }

  /** Genie has no approval-gated tools. */
  override async suspendedRuns(): Promise<ListAgentSuspendedRunsResponse> {
    return { runs: [], total: 0 };
  }

  /** Starter questions for this client's Genie space. */
  override async suggestions(_agentId?: string, signal?: AbortSignal): Promise<string[]> {
    const payload = await this.getJson(
      this.#url(MASTRA_ROUTES.suggestions),
      MastraSuggestionsResponseSchema,
      signal,
    );
    return payload.questions;
  }

  /** List the caller's Genie conversations as chat threads. */
  override async threads(
    options: { signal?: AbortSignal } = {},
  ): Promise<ListMemoryThreadsResponse> {
    const payload = await this.getJson(
      this.#url(MASTRA_ROUTES.threads),
      GenieThreadsResponseSchema,
      options.signal,
    );
    for (const thread of payload.threads) this.#rememberConversation(thread.id, thread.id);
    const threads = payload.threads.map((thread) => ({
      id: thread.id,
      ...(thread.title ? { title: thread.title } : {}),
      resourceId: "",
      createdAt: thread.createdAt,
      updatedAt: thread.createdAt,
      metadata: {},
    }));
    return {
      threads,
      total: threads.length,
      page: 0,
      perPage: threads.length,
      hasMore: false,
    } satisfies ListMemoryThreadsResponse;
  }

  /**
   * Load a Genie conversation's full transcript. Genie returns the whole
   * conversation at once, so only the first page carries messages.
   */
  override async history(options: {
    threadId: string;
    page?: number;
    signal?: AbortSignal;
  }): Promise<ListMemoryThreadMessagesResponse> {
    const page = options.page ?? 0;
    let messages: UIMessage[] = [];
    if (page === 0) {
      const payload = await this.getJson(
        this.#url(MASTRA_ROUTES.threads, options.threadId, MASTRA_ROUTES.messages),
        GenieThreadMessagesResponseSchema,
        options.signal,
      );
      messages = await validateUIMessages({ messages: payload.messages });
      this.#rememberConversation(options.threadId, options.threadId);
      // History ids already address their Genie message; the delete route
      // resolves a question id to the message that owns it.
      for (const message of messages) this.#genieMessageIds.set(message.id, message.id);
    }
    return {
      messages: [],
      uiMessages: [...messages].reverse(),
      total: messages.length,
      page,
      perPage: messages.length,
      hasMore: false,
    } satisfies ListMemoryThreadMessagesResponse;
  }

  /** Delete the Genie conversation behind a thread. */
  override async removeThread(
    threadId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const conversationId = this.#conversationIds.get(threadId);
    if (!conversationId) return;
    await this.#delete(this.#url(MASTRA_ROUTES.threads, conversationId), options.signal);
    this.#forgetConversation(conversationId);
  }

  /** Clearing a Genie thread deletes its conversation; the next turn starts a new one. */
  override async clearHistory(options: { threadId: string; signal?: AbortSignal }): Promise<void> {
    await this.removeThread(options.threadId, options);
  }

  /** Genie conversations cannot be renamed. */
  override async renameThread(): Promise<void> {
    throw new Error("Genie conversations cannot be renamed");
  }

  /** Delete the Genie messages behind the given transcript messages. */
  override async deleteMessages(
    threadId: string,
    messageIds: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const conversationId = this.#conversationIds.get(threadId);
    if (!conversationId) return;
    const genieIds = new Set(
      messageIds.flatMap((id) => {
        const genieId = this.#genieMessageIds.get(id);
        return genieId ? [genieId] : [];
      }),
    );
    for (const genieId of genieIds) {
      await this.#delete(
        this.#url(MASTRA_ROUTES.threads, conversationId, MASTRA_ROUTES.messages, genieId),
        options.signal,
      );
    }
  }
}
