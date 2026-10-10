import {
  ReasoningEffort as ReasoningEffortValue,
  type ReasoningEffort,
} from "@dbx-tools/shared-model";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Default reasoning on for capable models while preserving an explicit off choice. */
export const defaultReasoningEffort = (
  efforts: readonly ReasoningEffort[],
): ReasoningEffort | undefined =>
  efforts.includes(ReasoningEffortValue.Medium)
    ? ReasoningEffortValue.Medium
    : efforts.find((effort) => effort !== ReasoningEffortValue.None);

/** Namespace the last-selected model by plugin mount and agent. */
export const modelStorageKey = (basePath: string, agentId: string): string =>
  `dbx-mastra-model:${basePath}:${agentId}`;

const browserStorage = (): StorageLike | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

/** Read the last-selected model, tolerating unavailable browser storage. */
export const readStoredModel = (
  key: string,
  storage: StorageLike | undefined = browserStorage(),
): string => {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
};

/** Persist the selected model, including the empty server-default choice. */
export const storeSelectedModel = (
  key: string,
  model: string,
  storage: StorageLike | undefined = browserStorage(),
): void => {
  try {
    storage?.setItem(key, model);
  } catch {
    // Best-effort; the in-memory selection still works without persistence.
  }
};
