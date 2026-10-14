import { describe, expect, test } from "bun:test";
import type { WorkspaceClient } from "@databricks/appkit";
import type { MastraDBMessage } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";

import {
  ManagedAgentMemoryClient,
  ManagedMemoryRuntime,
  ManagedSessionMemoryStorage,
} from "../src/managed-memory.ts";

interface StoredSession {
  session_id: string;
  actor_id: string;
  metadata: Record<string, string>;
  create_time: string;
  update_time: string;
  last_activity_time: string;
  name: string;
}

function fakeWorkspaceClient() {
  const sessions = new Map<string, StoredSession>();
  const items = new Map<
    string,
    Array<{ item_id: string; data: Record<string, unknown>; create_time: string }>
  >();
  const searches: unknown[] = [];
  const extractions: unknown[] = [];
  let itemSequence = 0;

  const client = {
    apiClient: {
      request: async (request: {
        path: string;
        method: string;
        query?: Record<string, unknown>;
        payload?: Record<string, unknown>;
      }) => {
        const sessionMatch = /\/sessions\/([^/]+)$/.exec(request.path);
        const itemMatch = /\/sessions\/([^/]+)\/items$/.exec(request.path);
        const appendMatch = /\/sessions\/([^/]+)\/items:append$/.exec(request.path);
        const extractionMatch = /\/sessions\/([^/]+)\/extractions$/.exec(request.path);

        if (request.path.endsWith("/sessions") && request.method === "POST") {
          const id = String(request.query?.session_id);
          const now = new Date().toISOString();
          const session: StoredSession = {
            session_id: id,
            actor_id: String(request.payload?.actor_id),
            metadata: (request.payload?.metadata as Record<string, string>) ?? {},
            create_time: now,
            update_time: now,
            last_activity_time: now,
            name: `session-stores/test/sessions/${id}`,
          };
          sessions.set(id, session);
          items.set(id, []);
          return session;
        }
        if (request.path.endsWith("/sessions") && request.method === "GET") {
          const actor = /actor_id = "([^"]+)"/.exec(String(request.query?.filter))?.[1];
          return {
            sessions: [...sessions.values()].filter(
              (session) => !actor || session.actor_id === actor,
            ),
          };
        }
        if (sessionMatch && request.method === "GET") {
          const session = sessions.get(decodeURIComponent(sessionMatch[1]!));
          if (!session) throw Object.assign(new Error("not found"), { statusCode: 404 });
          return session;
        }
        if (sessionMatch && request.method === "PATCH") {
          const id = decodeURIComponent(sessionMatch[1]!);
          const current = sessions.get(id)!;
          const session = {
            ...current,
            metadata: request.payload?.metadata as Record<string, string>,
            update_time: new Date().toISOString(),
          };
          sessions.set(id, session);
          return session;
        }
        if (sessionMatch && request.method === "DELETE") {
          const id = decodeURIComponent(sessionMatch[1]!);
          sessions.delete(id);
          items.delete(id);
          return {};
        }
        if (appendMatch) {
          const id = decodeURIComponent(appendMatch[1]!);
          const stored = items.get(id)!;
          const appended = (request.payload?.items as Array<{ data: Record<string, unknown> }>).map(
            ({ data }) => ({
              item_id: `item-${++itemSequence}`,
              data,
              create_time: new Date(Date.now() + itemSequence).toISOString(),
            }),
          );
          stored.push(...appended);
          return { session_items: appended };
        }
        if (itemMatch) {
          return { session_items: items.get(decodeURIComponent(itemMatch[1]!)) ?? [] };
        }
        if (request.path.endsWith("/entries:search")) {
          searches.push(request.payload);
          return {
            results: [
              {
                managed_memory_entry: {
                  actor_id: request.payload?.actor_id,
                  path: "/preferences/response.md",
                  content: "Prefers concise answers.",
                  description: "Response preference",
                },
                score: 1,
              },
            ],
          };
        }
        if (extractionMatch) {
          extractions.push(request.payload);
          return { entries: [] };
        }
        throw new Error(`Unexpected ${request.method} ${request.path}`);
      },
    },
  } as unknown as WorkspaceClient;

  return { client, sessions, items, searches, extractions };
}

function message(
  id: string,
  text: string,
  overrides: Partial<MastraDBMessage> = {},
): MastraDBMessage {
  return {
    id,
    role: "user",
    createdAt: new Date(`2026-10-14T00:00:0${id.endsWith("2") ? 2 : 1}.000Z`),
    threadId: "thread-1",
    resourceId: "user-1",
    content: { format: 2, parts: [{ type: "text", text }] },
    ...overrides,
  };
}

describe("ManagedSessionMemoryStorage", () => {
  test("maps Mastra threads and append-only message updates onto Agent Sessions", async () => {
    const fake = fakeWorkspaceClient();
    const client = new ManagedAgentMemoryClient(fake.client, { sessionStore: "test" });
    const storage = new ManagedSessionMemoryStorage(client, "support");

    await storage.saveThread({
      thread: {
        id: "thread-1",
        resourceId: "user-1",
        title: "Original",
        metadata: { route: "/sales" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await storage.saveMessages({
      messages: [message("message-1", "Hello"), message("message-2", "Hi", { role: "assistant" })],
    });
    await storage.updateMessages({
      messages: [
        {
          id: "message-2",
          content: { metadata: { reviewed: true } },
        },
      ],
    });
    await storage.deleteMessages(["message-1"]);

    const history = await storage.listMessages({ threadId: "thread-1" });
    expect(history.messages.map((entry) => entry.id)).toEqual(["message-2"]);
    expect(history.messages[0]?.content.metadata).toEqual({ reviewed: true });
    const threads = await storage.listThreads({ filter: { resourceId: "user-1" } });
    expect(threads.threads).toHaveLength(1);
    expect(threads.threads[0]).toMatchObject({
      id: "thread-1",
      title: "Original",
      resourceId: "user-1",
      metadata: { route: "/sales" },
    });

    const copy = await storage.copyThread({
      sourceThreadId: "thread-1",
      newThreadId: "thread-2",
    });
    expect(copy.thread).toMatchObject({ id: "thread-2", resourceId: "user-1" });
    expect(Object.keys(copy.messageIdMap ?? {})).toEqual(["message-2"]);
    const copied = await storage.listMessages({ threadId: "thread-2" });
    expect(copied.messages).toHaveLength(1);
    expect(copied.messages[0]?.id).not.toBe("message-2");
  });
});

describe("ManagedMemoryRuntime", () => {
  test("recalls actor-scoped memory through a native Mastra input processor", async () => {
    const fake = fakeWorkspaceClient();
    const runtime = new ManagedMemoryRuntime(fake.client, {
      sessionStore: "test",
      memoryStore: "memory",
    });
    const processor = runtime.inputProcessor()!;
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "user-1");

    const result = await processor.processInput!({
      messages: [message("message-1", "How should you answer?")],
      systemMessages: [],
      requestContext,
      messageList: {} as never,
      state: {},
      retryCount: 0,
      abort: () => {
        throw new Error("aborted");
      },
    });

    expect(fake.searches).toEqual([
      { actor_id: "user-1", query: "How should you answer?", page_size: 10 },
    ]);
    expect(result).toMatchObject({
      systemMessages: [
        {
          role: "system",
          content: expect.stringContaining("Prefers concise answers."),
        },
      ],
    });
  });

  test("mirrors a Genie turn and optionally extracts memory", async () => {
    const fake = fakeWorkspaceClient();
    const runtime = new ManagedMemoryRuntime(fake.client, {
      sessionStore: "test",
      memoryStore: "memory",
      extractAfterGenieTurn: { instructions: "Keep durable preferences." },
    });

    await runtime.recordGenieTurn({
      actorId: "user-1",
      alias: "sales",
      conversationId: "conversation-1",
      question: "What did I ask for?",
      answer: "A concise answer.",
    });

    expect(fake.items.get("conversation-1")?.map((item) => item.data)).toEqual([
      { type: "message", role: "user", content: "What did I ask for?" },
      { type: "message", role: "assistant", content: "A concise answer." },
    ]);
    expect(fake.extractions).toEqual([
      {
        memory_store: "memory-stores/memory",
        instructions: "Keep durable preferences.",
      },
    ]);
  });
});
