import { randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DebugCaptureIdSchema,
  type DebugCaptureEvent,
  type DebugCaptureScalar,
} from "@dbx-tools/shared-appkit/debug";

type DebugCaptureMetadata = Record<string, DebugCaptureScalar>;

/** Default local directory for browser debug capture JSONL files. */
export function defaultDebugCaptureDirectory(): string {
  return process.env.NODE_ENV === "development"
    ? join(process.cwd(), ".tmp", "debug-captures")
    : join(tmpdir(), "dbx-tools-debug-captures");
}

function serializeLines(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** Filesystem-backed JSONL storage for AppKit browser debug captures. */
export class DebugCaptureStorage {
  readonly directory: string;
  readonly #pending = new Map<string, Promise<void>>();

  constructor(directory = defaultDebugCaptureDirectory()) {
    this.directory = directory;
  }

  /** Resolve a validated capture identifier to its JSONL file. */
  path(captureId: string): string {
    return join(this.directory, `${DebugCaptureIdSchema.parse(captureId)}.jsonl`);
  }

  /** Create a new capture and write its metadata record. */
  async start(metadata: DebugCaptureMetadata): Promise<string> {
    const captureId = `vp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      this.path(captureId),
      serializeLines([
        {
          kind: "capture-start",
          captureId,
          createdAt: new Date().toISOString(),
          metadata,
        },
      ]),
      { encoding: "utf8", flag: "wx" },
    );
    return captureId;
  }

  /** Append an ordered browser event batch to an active capture. */
  append(captureId: string, events: readonly DebugCaptureEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    return this.enqueue(captureId, () =>
      appendFile(
        this.path(captureId),
        serializeLines(events.map((event) => ({ kind: "event", ...event }))),
        "utf8",
      ),
    );
  }

  /** Append final events and mark a capture complete. */
  stop(captureId: string, events: readonly DebugCaptureEvent[]): Promise<void> {
    return this.enqueue(captureId, async () => {
      if (events.length > 0) {
        await appendFile(
          this.path(captureId),
          serializeLines(events.map((event) => ({ kind: "event", ...event }))),
          "utf8",
        );
      }
      await appendFile(
        this.path(captureId),
        serializeLines([{ kind: "capture-stop", stoppedAt: new Date().toISOString() }]),
        "utf8",
      );
    });
  }

  private enqueue(captureId: string, operation: () => Promise<void>): Promise<void> {
    DebugCaptureIdSchema.parse(captureId);
    const previous = this.#pending.get(captureId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#pending.set(captureId, current);
    const cleanup = () => {
      if (this.#pending.get(captureId) === current) this.#pending.delete(captureId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }
}
