import {
  Plugin,
  lakebase,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import { plugin as pluginLookup } from "@dbx-tools/appkit";
import { net as databricksNet } from "@dbx-tools/databricks";
import { PostgresTopicBus, type SerializableValue, type TopicMetadata } from "@dbx-tools/postgres";
import { error, log } from "@dbx-tools/shared-core";
import { z } from "zod";

const TOPIC = "demo-viewers";
const logger = log.logger("demo:bus");

function isSerializableValue(value: unknown): value is SerializableValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isSerializableValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isSerializableValue);
}

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

  async shutdown(): Promise<void> {
    await this.bus?.close();
  }

  override injectRoutes(router: IAppRouter): void {
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

        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          void unsubscribe();
          res.end();
        });
      },
    });
  }

  private requireBus(res: { status(code: number): { json(body: unknown): unknown } }) {
    if (this.bus) return this.bus;
    res.status(503).json({ error: "Message bus is still starting." });
    return undefined;
  }
}

export const busDemo = toPlugin(BusDemoPlugin);
