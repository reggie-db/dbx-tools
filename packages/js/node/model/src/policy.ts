/** TypeScript-owned model-family and serving capability policy. */

import {
  ModelClass,
  type ReasoningEffort,
  type ServingEndpointSummary,
} from "@dbx-tools/shared-model/contracts";

import { compareVersionTuples, supportsToolsByFamily, versionTuple } from "./classify.ts";

/** Recognized model families used by routing and provider policy. */
export const ModelFamily = {
  Claude: "claude",
  Gpt: "gpt",
  Gemini: "gemini",
  Llama: "llama",
  Grok: "grok",
  Deepseek: "deepseek",
  Qwen: "qwen",
  Glm: "glm",
  Kimi: "kimi",
  Gemma: "gemma",
  Inkling: "inkling",
  Bge: "bge",
  Gte: "gte",
} as const;

/** Recognized model family value. */
export type ModelFamily = (typeof ModelFamily)[keyof typeof ModelFamily];

const FAMILIES = Object.values(ModelFamily);

const STANDARD: ReasoningEffort[] = ["low", "medium", "high"];
const GPT_5_6: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const GPT_5_5_PRO: ReasoningEffort[] = ["medium", "high", "xhigh"];
const CLAUDE: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const GEMINI: ReasoningEffort[] = ["minimal", "low", "medium", "high"];

interface ParsedModelName {
  family: ModelFamily;
  version: number[];
  model: string[];
}

/** Return the normalized family parsed from a model identity. */
export function modelFamily(name: string): ModelFamily | undefined {
  return parseModelName(name)?.family;
}

/** Rank a family by how major it is; unrecognized families sort last. */
export function modelFamilyRank(family: string): number {
  const index = FAMILIES.indexOf(family as ModelFamily);
  return index >= 0 ? index : FAMILIES.length;
}

/** Normalize a recognized model identity into family, version, and variant tokens. */
export function modelSearchQuery(name: string): string | undefined {
  const parsed = parseModelName(name);
  if (!parsed) return undefined;
  return [parsed.family, ...parsed.version.map(String), ...parsed.model].join(" ");
}

/**
 * Return whether `name` has native web search: an exact documented identity, or
 * a later {@link versionTuple} in the same family as a documented native
 * web-search model. Intra-family floors use the name digit parser so identities
 * like `databricks-claude-opus-4-8` and `system.ai.gpt-6-1-sol` compare.
 * Hosted GPT-OSS weights never inherit.
 */
export function inheritsNativeWebSearch(name: string, documented: Iterable<string>): boolean {
  const documentedKeys = documented instanceof Set ? documented : new Set(documented);
  const key = modelSearchQuery(name)?.replaceAll(" ", "-");
  if (key && documentedKeys.has(key)) return true;
  const family = modelFamily(name);
  if (!family || isOpenWeightsGpt(name)) return false;
  const version = versionTuple(name);
  if (isZeroVersion(version)) return false;
  let floor: readonly number[] | undefined;
  for (const entry of documentedKeys) {
    if (modelFamily(entry) !== family || isOpenWeightsGpt(entry)) continue;
    const documentedVersion = versionTuple(entry);
    if (isZeroVersion(documentedVersion)) continue;
    if (!floor || compareVersionTuples(documentedVersion, floor) < 0) {
      floor = documentedVersion;
    }
  }
  return floor !== undefined && compareVersionTuples(version, floor) >= 0;
}

/**
 * Return whether an identity names a Databricks-hosted foundation model
 * (`databricks-*` endpoint or `system.ai.*` model service). Custom and
 * external endpoints use arbitrary names, so their digits are not versions.
 */
export function isFoundationModelIdentity(name: string): boolean {
  return /^(?:databricks-|system\.ai\.)/i.test(name.trim());
}

/** Return whether an identity is hosted GPT-OSS rather than a GPT generation. */
export function isOpenWeightsGpt(name: string): boolean {
  return modelFamily(name) === "gpt" && /(?:^|[-_.])oss(?:[-_.]|$)/i.test(name);
}

function isZeroVersion(version: readonly number[]): boolean {
  return version.every((part) => (part ?? 0) === 0);
}

/** Return the reasoning efforts accepted by a model family. */
export function modelReasoningEfforts(name: string): ReasoningEffort[] {
  const normalized = name.toLowerCase();
  const parsed = parseModelName(name);
  let efforts: ReasoningEffort[] = [];
  if (parsed?.family === "gpt" && parsed.version.length > 0) {
    const [major = 0, minor = 0] = parsed.version;
    if (major >= 5) {
      efforts =
        major === 5 && minor === 5 && parsed.model.includes("pro")
          ? GPT_5_5_PRO
          : major === 5 && minor === 6
            ? GPT_5_6
            : STANDARD;
    }
  }
  if (parsed?.family === "gpt" && parsed.model.includes("oss")) efforts = STANDARD;
  if (parsed?.family === "claude") {
    const [major = 0, minor = 0] = parsed.version;
    if (major > 3 || (major === 3 && minor >= 7)) efforts = CLAUDE;
  }
  if (parsed?.family === "gemini") efforts = GEMINI;
  if (normalized.includes("codex") || /(?:^|[-_./])o(?:1|3|4)(?:[-_./]|$)/i.test(name)) {
    efforts = STANDARD;
  }
  return efforts;
}

/** Return whether policy verifies a complete tool-calling round trip. */
export function modelSupportsTools(name: string): boolean {
  return supportsToolsByFamily(name);
}

/** Return whether a discovered endpoint can be used for a tool-calling chat. */
export function endpointSupportsTools(endpoint: ServingEndpointSummary): boolean {
  const embedding =
    endpoint.task === "llm/v1/embeddings" || endpoint.class === ModelClass.Embedding;
  const chat = !embedding && (endpoint.task === "llm/v1/chat" || endpoint.class !== undefined);
  return chat && (endpoint.supportsTools ?? modelSupportsTools(endpoint.name));
}

/** Return whether a model requires Databricks' native Responses endpoint. */
export function isResponsesOnly(name: string): boolean {
  if (name.toLowerCase().includes("codex")) return true;
  const parsed = parseModelName(name);
  if (!parsed || parsed.family !== "gpt" || parsed.model.includes("oss")) return false;
  const [major = 0, minor = 0] = parsed.version;
  return major > 5 || (major === 5 && minor >= 4);
}

/** Return the Databricks inference protocol required by a model. */
export function modelServingApi(name: string): "chat" | "responses" {
  return isResponsesOnly(name) ? "responses" : "chat";
}

/** Return the Chat Completions effort required when function tools are present. */
export function chatToolReasoningEffort(name: string): ReasoningEffort | undefined {
  const parsed = parseModelName(name);
  if (!parsed || parsed.family !== "gpt") return undefined;
  const [major = 0, minor = 0] = parsed.version;
  return major === 5 && minor === 6 ? "none" : undefined;
}

/** Derive provider-specific model names from a Databricks model identity. */
export function modelServiceNames(name: string): Record<string, string> {
  const parsed = parseModelName(name);
  if (!parsed) return {};
  const version = parsed.version.join(".");
  const suffix = parsed.model.length ? `-${parsed.model.join("-")}` : "";
  switch (parsed.family) {
    case "gpt":
      return parsed.model.includes("oss") ? {} : { openai: `gpt-${version}${suffix}` };
    case "claude": {
      const [variant, ...rest] = parsed.model;
      return variant
        ? { anthropic: `claude-${variant}-${version}${rest.length ? `-${rest.join("-")}` : ""}` }
        : {};
    }
    case "gemini":
    case "gemma":
      return { google: `${parsed.family}-${version}${suffix}` };
    case "glm":
      return { zhipu: `glm-${version}${suffix}` };
    case "grok":
      return { xai: `grok-${version}${suffix}` };
    case "llama":
      return { meta: `llama-${version}${suffix}` };
    case "qwen":
      return { alibaba: `qwen${version}${suffix}` };
    case "deepseek":
      return { deepseek: `deepseek-v${parsed.version[0] ?? ""}${suffix}` };
    case "kimi":
      return { moonshot: `kimi-k${parsed.version[0] ?? ""}${suffix}` };
    default:
      return {};
  }
}

function parseModelName(name: string): ParsedModelName | undefined {
  const tokens = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let familyIndex = -1;
  let family: ParsedModelName["family"] | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const compactQwen = /^qwen(\d+)$/.exec(token);
    if (compactQwen) {
      familyIndex = index;
      family = "qwen";
      break;
    }
    if (FAMILIES.includes(token as ModelFamily)) {
      familyIndex = index;
      family = token as ParsedModelName["family"];
      break;
    }
  }
  if (!family || familyIndex < 0) return undefined;
  const remainder = tokens.slice(familyIndex + 1);
  const numeric = (value: string) => /^\d+$/.test(value);
  let versionStart = remainder.findIndex(numeric);
  if (family === "qwen" && /^qwen\d+$/.test(tokens[familyIndex]!)) {
    versionStart = 0;
    remainder.unshift(tokens[familyIndex]!.slice(4));
  }
  if (family === "deepseek") {
    const prefixed = remainder.findIndex((value) => /^v\d+$/.test(value));
    if (prefixed >= 0) remainder[prefixed] = remainder[prefixed]!.slice(1);
    versionStart = remainder.findIndex(numeric);
  }
  if (family === "kimi") {
    const prefixed = remainder.findIndex((value) => /^k\d+$/.test(value));
    if (prefixed >= 0) remainder[prefixed] = remainder[prefixed]!.slice(1);
    versionStart = remainder.findIndex(numeric);
  }
  if (versionStart < 0) return { family, version: [], model: remainder };
  const version: number[] = [];
  let cursor = versionStart;
  while (cursor < remainder.length && version.length < 2 && numeric(remainder[cursor]!)) {
    version.push(Number(remainder[cursor]));
    cursor += 1;
  }
  return {
    family,
    version,
    model: [...remainder.slice(0, versionStart), ...remainder.slice(cursor)],
  };
}
