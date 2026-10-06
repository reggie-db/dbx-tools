/** Lightweight model retirement state shared by discovery and metadata caches. */
import type { ModelStatus, ServingEndpointSummary } from "@dbx-tools/shared-model/contracts";

import type { RetiredModelsSnapshot } from "./_metadata-contract.ts";
import retiredModelsSnapshotJson from "./generated/retired-models.json" with { type: "json" };

const snapshot = retiredModelsSnapshotJson as RetiredModelsSnapshot;
const RETIRED_MODEL_PREFIXES = new Set([
  "ai",
  "anthropic",
  "databricks",
  "dbx",
  "google",
  "meta",
  "openai",
  "system",
]);

let names: readonly string[] = Object.freeze([...snapshot.models]);
let keys = retiredKeys(names);

export const COMMITTED_RETIRED_MODELS = snapshot.models;
export const RETIRED_MODELS_GENERATED_AT = snapshot.generatedAt;

/** Replace retirement state after metadata cache hydration or refresh. */
export function replaceRetiredModelNames(models: readonly string[]): void {
  names = Object.freeze([...models]);
  keys = retiredKeys(names);
}

/** Return the active retired-model names. */
export function retiredModelNames(): readonly string[] {
  return names;
}

/** Resolve whether any supplied identity is listed as retired. */
export function modelStatusFor(
  ...models: readonly (string | ServingEndpointSummary)[]
): ModelStatus {
  const deprecated = models
    .flatMap((model) => modelIdentities(model))
    .some((identity) => {
      const candidate = retiredModelKey(identity);
      for (const key of keys) {
        if (candidate === key || candidate.startsWith(`${key}-`)) return true;
      }
      return false;
    });
  return { deprecated };
}

function retiredKeys(models: readonly string[]): ReadonlySet<string> {
  return new Set(models.map(retiredModelKey).filter(Boolean));
}

function modelIdentities(model: string | ServingEndpointSummary): string[] {
  if (typeof model === "string") return [model];
  return [
    model.name,
    model.displayName,
    model.modelServiceName,
    ...Object.values(model.serviceNames ?? {}),
  ].filter((value): value is string => Boolean(value));
}

function retiredModelKey(value: string): string {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  while (tokens[0] && RETIRED_MODEL_PREFIXES.has(tokens[0])) tokens.shift();
  return tokens.join("-");
}
