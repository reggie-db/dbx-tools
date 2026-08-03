/**
 * The demo's message-bus page, server side: one Postgres topic shared by every
 * open browser tab.
 *
 * Shows the fan-out shape `@dbx-tools/postgres`'s {@link PostgresTopicBus} exists
 * for. A `POST` broadcasts on the topic and an SSE stream per viewer replays
 * whatever arrives, so a message typed in one tab shows up in all of them - and,
 * over the tunnel, in another person's browser. Nothing is stored: this is live
 * fan-out, not chat history, which is why a viewer only sees messages published
 * after it connected.
 *
 * It is also where the structured envelope earns its keep. The route adds request
 * context (who sent it, from which IP, through which host) as METADATA rather than
 * folding it into the body, so the page can label a message `you` or `other` and
 * show the merged context without the body having to carry a fixed schema.
 *
 * @module
 */

import {
  Plugin,
  lakebase,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import { plugin as pluginLookup } from "@dbx-tools/appkit";
import { net as databricksNet } from "@dbx-tools/databricks";
import { PostgresTopicBus, isSerializableValue, type TopicMetadata } from "@dbx-tools/postgres";
import { error, log } from "@dbx-tools/shared-core";
import { z } from "zod";

/**
 * The single topic every viewer publishes and subscribes to. A real app would key
 * this per room or per document; one constant is what makes every tab a peer.
 */
const TOPIC = "demo-viewers";
const logger = log.logger("demo:bus");

/**
 * Zod refinement narrowing a parsed JSON object to bus metadata. The bus enforces
 * the same rule on broadcast; checking here turns it into a 400 with the rest of
 * the validation errors instead of a 500 from a rejected publish.
 */
function isTopicMetadata(value: unknown): value is TopicMetadata {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isSerializableValue(value)
  );
}

const sendSchema = z.object({
  viewerId: z.string().trim().min(1).max(100),
  user: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(120),
  metadata: z.record(z.string(), z.unknown()).refine(isTopicMetadata).default({}),
  body: z.unknown().refine(isSerializableValue, "Body must be JSON serializable"),
});

let environmentMetadata: Promise<Record<string, string>> | undefined;

/**
 * Context this process can only learn asynchronously, resolved once and reused for
 * every broadcast.
 *
 * The bus fills in `project` and a public IP from the ENVIRONMENT on its own;
 * running locally there is no such variable, so the demo discovers the real
 * outbound IP over the network. That is exactly the case a
 * `TopicMetadataProvider` is for - it is called per broadcast, hence the memoized
 * promise. A failed lookup is logged and omitted rather than failing the publish,
 * since the IP is a nice-to-have label.
 */
function resolveEnvironmentMetadata(): Promise<Record<string, string>> {
  environmentMetadata ??= (async () => {
    const metadata: Record<string, string> = {
      project: process.env.DATABRICKS_APP_NAME?.trim() || "dbx-tools-demo",
    };
    try {
      metadata.publicIp = await databricksNet.getPublicIp();
    } catch (cause) {
      logger.warn("public IP unavailable", { error: error.errorMessage(cause) });
    }
    return metadata;
  })();
  return environmentMetadata;
}

/**
 * AppKit plugin owning the demo's bus, its send route, and its SSE stream.
 *
 * Construction is deferred to `setup:complete` because the bus needs the sibling
 * native `lakebase` plugin's pool, which does not exist until every plugin has set
 * up. Requests arriving before then get a 503 rather than a crash.
 */
class BusDemoPlugin extends Plugin {
  static manifest = {
    name: "bus-demo",
    displayName: "Message Bus Demo",
    description: "Broadcasts Postgres topic messages to multiple browser viewers.",
    stability: "beta",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"bus-demo">;

  private bus: PostgresTopicBus | undefined;

  override async setup(): Promise<void> {
    this.context?.onLifecycle("setup:complete", async () => {
      const lake = pluginLookup.require(this.context, lakebase, "bus-demo");
      this.bus = new PostgresTopicBus(lake.exports().pool, {
        metadata: resolveEnvironmentMetadata,
        onError: (cause) =>
          logger.error("topic listener failed", { error: error.errorMessage(cause) }),
      });
      await this.bus.start();
      logger.info("ready", { topic: TOPIC });
    });
  }

  /** Returns the listener connection to the Lakebase pool on app shutdown. */
  async shutdown(): Promise<void> {
    await this.bus?.close();
  }

  override injectRoutes(router: IAppRouter): void {
    // POST /api/bus-demo/messages - publish one message to every viewer. 202, not
    // 201: nothing was created, and the notification only reaches sessions that
    // are already listening.
    this.route(router, {
      name: "send",
      method: "post",
      path: "/messages",
      handler: async (req, res) => {
        const bus = this.requireBus(res);
        if (!bus) return;
        const parsed = sendSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Enter a user name and message." });
          return;
        }
        const forwardedFor = req.get("x-forwarded-for")?.split(",")[0]?.trim();
        const message = await bus.broadcast(TOPIC, {
          type: parsed.data.type,
          // Request context first so the caller's own `metadata` can override any
          // of it, matching how the bus layers automatic context under the
          // caller's. `viewerId` is what lets the page tell your messages from
          // everyone else's.
          metadata: {
            viewerId: parsed.data.viewerId,
            user: parsed.data.user,
            clientIp: forwardedFor || req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.get("user-agent") ?? "unknown",
            host: req.get("host") ?? "unknown",
            ...parsed.data.metadata,
          },
          body: parsed.data.body,
        });
        res.status(202).json(message);
      },
    });

    // GET /api/bus-demo/events - one SSE stream per open viewer. The subscription
    // lives as long as the response, so the request's `close` is what unsubscribes;
    // without that a reloaded tab leaks a listener writing to a dead socket.
    this.route(router, {
      name: "events",
      method: "get",
      path: "/events",
      handler: async (req, res) => {
        const bus = this.requireBus(res);
        if (!bus) return;
        res.set({
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        const unsubscribe = await bus.listen(TOPIC, (message) => {
          res.write(`id: ${message.id}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ topic: TOPIC })}\n\n`);

        // Comment-only frames keep proxies and load balancers from closing an idle
        // stream, which is otherwise the failure mode of a demo nobody is typing in.
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          void unsubscribe();
          res.end();
        });
      },
    });
  }

  /**
   * The bus or a 503. Covers the window between the server accepting connections
   * and `setup:complete` building the bus, which a page loaded during a restart
   * will hit.
   */
  private requireBus(res: { status(code: number): { json(body: unknown): unknown } }) {
    if (this.bus) return this.bus;
    res.status(503).json({ error: "Message bus is still starting." });
    return undefined;
  }
}

/** The `bus-demo` plugin factory, added to the demo server's plugin list. */
export const busDemo = toPlugin(BusDemoPlugin);
