import type { UIMessage } from "ai";
import { z } from "zod";

const ACTIVE_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const StoredActiveRunSchema = z
  .object({
    threadId: z.string().min(1).describe("Mastra thread receiving the background turn."),
    runId: z.string().min(1).describe("Mastra background run identifier."),
    assistantId: z.string().min(1).describe("Client assistant message identifier."),
    userMessage: z
      .object({
        id: z.string().min(1),
        role: z.literal("user"),
        parts: z.array(z.unknown()),
      })
      .passthrough()
      .describe("Submitted user message restored before stream replay."),
    startedAt: z.number().int().nonnegative().describe("Client epoch time when the run started."),
  })
  .strict()
  .describe("Reload-recoverable Mastra background run metadata.");

export type StoredActiveRun = Omit<z.infer<typeof StoredActiveRunSchema>, "userMessage"> & {
  userMessage: UIMessage;
};

const StoredActiveRunFileSchema = z
  .object({
    version: z.literal(1).describe("Active run storage format version."),
    runs: z.array(StoredActiveRunSchema).describe("Background runs awaiting terminal completion."),
  })
  .strict()
  .describe("Browser-persisted Mastra background run registry.");

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const activeRunStorageKey = (basePath: string, agentId: string): string =>
  `dbx-mastra-active-runs:${basePath}:${agentId}`;

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Read current non-stale background runs, deleting malformed storage. */
export function readStoredActiveRuns(
  key: string,
  storage: StorageLike | undefined = browserStorage(),
  now = Date.now(),
): StoredActiveRun[] {
  if (!storage) return [];
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return [];
    const parsed = StoredActiveRunFileSchema.parse(JSON.parse(serialized));
    const parsedRuns: StoredActiveRun[] = parsed.runs.map((run) => ({
      ...run,
      userMessage: run.userMessage as UIMessage,
    }));
    const runs = parsedRuns.filter((run) => now - run.startedAt <= ACTIVE_RUN_MAX_AGE_MS);
    if (runs.length !== parsed.runs.length) writeStoredActiveRuns(key, runs, storage);
    return runs as StoredActiveRun[];
  } catch {
    try {
      storage.removeItem(key);
    } catch {}
    return [];
  }
}

/** Add or replace one reload-recoverable background run. */
export function storeActiveRun(
  key: string,
  run: StoredActiveRun,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage) return;
  const runs = readStoredActiveRuns(key, storage).filter(
    (candidate) => candidate.runId !== run.runId,
  );
  writeStoredActiveRuns(key, [...runs, run], storage);
}

/** Remove one terminal or explicitly aborted background run. */
export function removeStoredActiveRun(
  key: string,
  runId: string,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage) return;
  const runs = readStoredActiveRuns(key, storage).filter((run) => run.runId !== runId);
  writeStoredActiveRuns(key, runs, storage);
}

function writeStoredActiveRuns(key: string, runs: StoredActiveRun[], storage: StorageLike): void {
  try {
    if (runs.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify({ version: 1, runs }));
  } catch {
    // Browser persistence is best-effort; the live in-memory run remains valid.
  }
}
