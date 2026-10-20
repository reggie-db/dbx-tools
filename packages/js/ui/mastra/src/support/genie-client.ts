import { routes, wire, type MastraClientConfig } from "@dbx-tools/shared-mastra";
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
  override readonly feedbackMode = "none";
  override readonly threadRename = false;
  override readonly attachments = false;
  override readonly followUpSuggestions: "none" | "genie";
  /** Thread ids known to be Genie conversations (listed, loaded, or announced). */
  readonly #conversations = new Set<string>();
  /** Transcript message id to Genie message id, for regenerate cleanup. */
  readonly #genieMessageIds = new Map<string, string>();

  constructor(config: MastraClientConfig, alias: string) {
    super(config);
    this.alias = alias;
    this.followUpSuggestions =
      config.followUpSuggestions === "genie" || config.followUpSuggestions === "auto"
        ? "genie"
        : "none";
  }

  #url(...parts: string[]): string {
    return `${this.basePath}${routes.genieRoutePath(this.alias, ...parts)}`;
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
    const conversationId =
      params.threadId && this.#conversations.has(params.threadId) ? params.threadId : undefined;
    const response = await this.uiStream({
      path: this.#url(routes.MASTRA_ROUTES.chat),
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
          if (chunk.type === wire.GENIE_CONVERSATION_PART_TYPE) {
            const data = wire.GenieConversationPartDataSchema.safeParse(chunk.data);
            if (data.success) {
              resolved = data.data.conversationId;
              this.#conversations.add(resolved);
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
      this.#url(routes.MASTRA_ROUTES.suggestions),
      wire.MastraSuggestionsResponseSchema,
      signal,
    );
    return payload.questions;
  }

  /** List the caller's Genie conversations as chat threads. */
  override async threads(
    options: { signal?: AbortSignal } = {},
  ): Promise<ListMemoryThreadsResponse> {
    const payload = await this.getJson(
      this.#url(routes.MASTRA_ROUTES.threads),
      wire.GenieThreadsResponseSchema,
      options.signal,
    );
    for (const thread of payload.threads) this.#conversations.add(thread.id);
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
        this.#url(routes.MASTRA_ROUTES.threads, options.threadId, routes.MASTRA_ROUTES.messages),
        wire.GenieThreadMessagesResponseSchema,
        options.signal,
      );
      messages = await validateUIMessages({ messages: payload.messages });
      this.#conversations.add(options.threadId);
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
    if (!this.#conversations.has(threadId)) return;
    await this.#delete(this.#url(routes.MASTRA_ROUTES.threads, threadId), options.signal);
    this.#conversations.delete(threadId);
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
    if (!this.#conversations.has(threadId)) return;
    const genieIds = new Set(
      messageIds.flatMap((id) => {
        const genieId = this.#genieMessageIds.get(id);
        return genieId ? [genieId] : [];
      }),
    );
    for (const genieId of genieIds) {
      await this.#delete(
        this.#url(routes.MASTRA_ROUTES.threads, threadId, routes.MASTRA_ROUTES.messages, genieId),
        options.signal,
      );
    }
  }
}
