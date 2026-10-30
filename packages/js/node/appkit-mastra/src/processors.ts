/**
 * Mastra stream processors wired onto the plugin's agents.
 *
 * Input processors apply provider-aware reasoning defaults, remove incompatible
 * provider continuation state, and scrub turn-scoped chart ids from Memory.
 *
 * @module
 */

import { isRecord, log } from "@dbx-tools/shared-core";
import { ProviderHistoryCompat } from "@mastra/core/processors";
import type {
  CompatRule,
  InputProcessor,
  ProcessInputArgs,
  ProcessInputStepArgs,
  ProcessInputStepResult,
} from "@mastra/core/processors";
import type { JSONValue } from "ai";

import { RESPONSES_PROVIDER_OPTIONS } from "./model.ts";

const logger = log.logger("mastra/processors");

const RESPONSES_PROVIDER_SUFFIX = ".responses";
const MODEL_BOUND_PROVIDER_FIELDS = [
  "itemId",
  "resultItemId",
  "reasoningEncryptedContent",
] as const;

interface ModelBoundResponsesState {
  encryptedReasoning: Set<string>;
  itemIds: Set<string>;
  reasoningItemIds: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function responsesProviderName(model: unknown): string | undefined {
  const provider = asRecord(model)?.provider;
  if (typeof provider !== "string" || !provider.endsWith(RESPONSES_PROVIDER_SUFFIX)) {
    return undefined;
  }
  return provider.slice(0, -RESPONSES_PROVIDER_SUFFIX.length);
}

/** Add stateless Responses defaults only after Mastra resolves the step model. */
export function buildResponsesProviderOptionsProcessor(sendReasoning: boolean): InputProcessor {
  return {
    id: "databricks-responses-provider-options",
    description:
      "Applies stateless replay and visible reasoning defaults to Databricks Responses models.",
    processInputStep(args: ProcessInputStepArgs) {
      const providerName = responsesProviderName(args.model);
      if (!providerName) return;
      const existing = args.providerOptions?.[providerName] ?? {};
      const next: Record<string, JSONValue> = {
        ...RESPONSES_PROVIDER_OPTIONS.openai,
        ...existing,
        store: false,
      };
      if (!sendReasoning) delete next.reasoningSummary;
      return {
        providerOptions: {
          ...args.providerOptions,
          [providerName]: next,
        },
      } satisfies ProcessInputStepResult;
    },
  };
}

function providerState(metadata: unknown): {
  encryptedReasoning: string[];
  itemIds: string[];
} {
  const encryptedReasoning: string[] = [];
  const itemIds: string[] = [];
  const providers = asRecord(metadata);
  if (!providers) return { encryptedReasoning, itemIds };
  for (const value of Object.values(providers)) {
    const provider = asRecord(value);
    if (!provider) continue;
    if (typeof provider.reasoningEncryptedContent === "string") {
      encryptedReasoning.push(provider.reasoningEncryptedContent);
    }
    for (const field of ["itemId", "resultItemId"] as const) {
      if (typeof provider[field] === "string") itemIds.push(provider[field]);
    }
  }
  return { encryptedReasoning, itemIds };
}

function foreignResponsesState(
  messageList: Parameters<NonNullable<CompatRule["applyToPrompt"]>>[0]["messageList"],
  targetModelId: string,
): ModelBoundResponsesState {
  const state: ModelBoundResponsesState = {
    encryptedReasoning: new Set(),
    itemIds: new Set(),
    reasoningItemIds: new Set(),
  };
  if (!messageList) return state;
  for (const message of messageList.get.all.db()) {
    if (message.role !== "assistant") continue;
    const originModelId = message.content.metadata?.modelId;
    if (typeof originModelId !== "string" || originModelId === targetModelId) continue;
    for (const part of message.content.parts) {
      const values = providerState(part.providerMetadata);
      for (const value of values.encryptedReasoning) state.encryptedReasoning.add(value);
      for (const value of values.itemIds) {
        state.itemIds.add(value);
        if (part.type === "reasoning") state.reasoningItemIds.add(value);
      }
    }
  }
  return state;
}

function hasForeignReasoningState(
  part: unknown,
  state: ModelBoundResponsesState,
): boolean {
  const record = asRecord(part);
  const values = providerState(record?.providerOptions ?? record?.providerMetadata);
  return (
    values.encryptedReasoning.some((value) => state.encryptedReasoning.has(value)) ||
    values.itemIds.some((value) => state.reasoningItemIds.has(value))
  );
}

function stripForeignItemIds<T>(part: T, state: ModelBoundResponsesState): T {
  const record = asRecord(part);
  const providerOptions = asRecord(record?.providerOptions);
  if (!providerOptions) return part;
  let changed = false;
  const nextProviderOptions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(providerOptions)) {
    const provider = asRecord(value);
    if (!provider) {
      nextProviderOptions[name] = value;
      continue;
    }
    const nextProvider = { ...provider };
    for (const field of MODEL_BOUND_PROVIDER_FIELDS) {
      const fieldValue = nextProvider[field];
      const foreign =
        typeof fieldValue === "string" &&
        (field === "reasoningEncryptedContent"
          ? state.encryptedReasoning.has(fieldValue)
          : state.itemIds.has(fieldValue));
      if (!foreign) continue;
      delete nextProvider[field];
      changed = true;
    }
    if (Object.keys(nextProvider).length > 0) nextProviderOptions[name] = nextProvider;
  }
  if (!changed) return part;
  return {
    ...record,
    ...(Object.keys(nextProviderOptions).length > 0
      ? { providerOptions: nextProviderOptions }
      : { providerOptions: undefined }),
  } as T;
}

/** Remove Responses continuation state produced by a different concrete model. */
export const stripForeignResponsesState: CompatRule = {
  name: "databricks-strip-foreign-responses-state",
  applyToPrompt({ prompt, model, messageList }) {
    if (!responsesProviderName(model)) return;
    const targetModelId = asRecord(model)?.modelId;
    if (typeof targetModelId !== "string") return;
    const state = foreignResponsesState(messageList, targetModelId);
    if (state.encryptedReasoning.size === 0 && state.itemIds.size === 0) return;

    let changed = false;
    const next = [];
    for (const message of prompt) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        next.push(message);
        continue;
      }
      const content = [];
      let messageChanged = false;
      for (const part of message.content) {
        if (part.type === "reasoning" && hasForeignReasoningState(part, state)) {
          changed = true;
          messageChanged = true;
          continue;
        }
        const stripped = stripForeignItemIds(part, state);
        if (stripped !== part) {
          changed = true;
          messageChanged = true;
        }
        content.push(stripped);
      }
      if (!messageChanged) {
        next.push(message);
      } else if (content.length > 0) {
        next.push({ ...message, content });
      }
    }
    return changed ? next : undefined;
  },
};

/** Mastra-owned compatibility processor extended for Databricks Responses routing. */
export const providerHistoryCompatProcessor = new ProviderHistoryCompat({
  additionalRules: [stripForeignResponsesState],
});

/**
 * Recursively clone `value`, omitting any property whose key is
 * `chartId`. Arrays are mapped element-wise; primitives are
 * returned as-is. The result is structurally identical to the
 * input minus chartIds, so downstream message-shape consumers
 * keep working.
 */
function stripChartIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripChartIds);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === "chartId") continue;
      out[key] = stripChartIds(val);
    }
    return out;
  }
  return value;
}

/**
 * Mastra input processor that strips `chartId` fields from every
 * tool-invocation result in prior assistant messages before they
 * reach the model.
 *
 * Why: chartIds are turn-scoped from the model's point of view -
 * each `prepare_chart` / `render_data` call mints a fresh id and
 * the host UI binds it to that turn's reply. Mastra Memory
 * replays prior tool results into the prompt; if old chartIds
 * leak through, the model is tempted to copy them verbatim into
 * the new turn's `[chart:<id>]` markers and the host UI ends up
 * rendering an unrelated chart from the chart cache (or
 * a 404 once the 1h TTL elapsed). This processor removes the
 * temptation by deleting `chartId` keys from every assistant
 * message's tool results before the prompt is built. The current
 * turn's tool results don't exist yet at `processInput` time, so
 * they pass through unmodified.
 *
 * The strip is recursive - any nested `chartId` field is removed,
 * regardless of which tool produced the result. This covers
 * `prepare_chart` / `render_data` top-level chartIds and any
 * legacy `datasets[].chartId` payloads uniformly without coupling
 * to specific tool ids.
 *
 * Wired onto every agent by default via `buildAgents`; opt out with
 * `MastraPluginConfig.stripStaleCharts: false`.
 */
export const stripStaleChartsProcessor: InputProcessor = {
  id: "strip-stale-charts",
  description:
    "Removes chartId fields from prior tool-invocation results so the model can't reuse turn-scoped ids from memory.",
  processInput(args: ProcessInputArgs) {
    let stripped = 0;
    for (const message of args.messages) {
      if (message.role !== "assistant") continue;
      const parts = message.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        // Tool-invocation parts hold the persisted tool result.
        // We don't scrub the input args (`rawInput` / `args`) because
        // the chartId there is the model's outgoing claim, not
        // anything it could re-reference; only `result` carries
        // ids that subsequent turns might copy.
        if ((part as { type?: unknown }).type !== "tool-invocation") {
          continue;
        }
        const inv = (part as { toolInvocation?: { result?: unknown } }).toolInvocation;
        if (!inv || inv.result === undefined) continue;
        const before = inv.result;
        const after = stripChartIds(before);
        // Cheap structural check via JSON length - the actual
        // strip writes a fresh object only when chartId keys
        // existed, so different stringification length is a
        // reliable signal that something was removed.
        if (
          typeof before === "object" &&
          before !== null &&
          JSON.stringify(before).length !== JSON.stringify(after).length
        ) {
          inv.result = after;
          stripped += 1;
        }
      }
    }
    if (stripped > 0) {
      logger.debug("stripped", { results: stripped });
    }
    return args.messages;
  },
};
