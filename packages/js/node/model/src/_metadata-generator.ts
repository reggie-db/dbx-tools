import { load, type CheerioAPI } from "cheerio";

import type {
  ModelCapabilitiesSnapshot,
  ModelRateLimitCatalogue,
  ModelRateLimitsSnapshot,
  ReasoningModelsSnapshot,
  RetiredModelsSnapshot,
} from "./_metadata-contract.ts";
import { modelSearchQuery } from "./policy.ts";
import {
  parseReasoning,
  REASONING_LEVELS,
  type ReasoningLevel,
  uniqueReasoningLevels,
} from "./reasoning-translation.ts";

type Selection = ReturnType<CheerioAPI>;

const ACCEPTED_VALUES_PATTERN =
  /(?:accepted values(?:\s+are|\s+vary)?|accepts(?:\s+values?(?:\s+of)?)?)\s*:?\s*([^.]+)/gi;
const FOR_MODEL_PATTERN =
  /For\s+([^,]+?),\s+(?:this parameter accepts(?:\s+values?\s+of)?|the (?:`?reasoning_effort`?|effort) parameter accepts(?:\s+values?\s+of)?)\s*([^.]+)/gi;
const TOKEN_PATTERN = /'([^']+)'|"([^"]+)"|`([^`]+)`|\b([a-z][a-z0-9_-]*)\b/gi;
const MODEL_CODE_PATTERN = /\bdatabricks-[a-z0-9][a-z0-9._-]*/gi;
/** Wire tokens advertised in Databricks docs; excludes prose words like `default`. */
const DOCUMENTATION_EFFORT_TOKENS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "extra-high",
  "extrahigh",
  "ultra",
  "ultra-high",
  "max",
  "maximum",
  "disabled",
]);

/** Parse retired model names from Databricks retirement-policy HTML. */
export function parseRetiredModels(html: string, generatedAt: number): RetiredModelsSnapshot {
  const $ = load(html);
  const models = new Set<string>();
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const header = collapseText($(rows.get(0)).find("th, td").first()).toLowerCase();
    if (header !== "open model" && header !== "partner model") return;
    rows.slice(1).each((__, row) => {
      for (const name of collapseText($(row).find("th, td").first()).split("/")) {
        const trimmed = name.trim();
        if (trimmed) models.add(trimmed);
      }
    });
  });
  if (models.size === 0) throw new Error("Databricks retirement tables contained no model names");
  return {
    generatedAt,
    models: [...models].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "base" }),
    ),
  };
}

/** Parse Responses and web-search documentation into model capability sets. */
export function parseModelCapabilities(
  responsesHtml: string,
  webSearchHtml: string,
  generatedAt: number,
): ModelCapabilitiesSnapshot {
  const responsesDocument = load(responsesHtml);
  const responses = modelsAfterHeading(responsesDocument, "databricks-hosted-foundation-models");
  if (responses.length === 0) {
    throw new Error("Databricks documentation contained no OpenAI Responses models");
  }
  const inputTypes = sectionElements(responsesDocument, "supported-input-types")
    .map((element) => collapseText(element))
    .join(" ")
    .toLowerCase();
  const inputTypeWords = new Set(inputTypes.split(/[^a-z0-9]+/).filter(Boolean));
  const imageInput = inputTypeWords.has("text") && inputTypeWords.has("image") ? responses : [];
  const applyPatch = codeValuesAfterHeading(responsesDocument, "limitations").includes(
    "apply_patch",
  )
    ? responses
    : [];
  const webSearch = nativeWebSearchModels(load(webSearchHtml), responses);
  if (webSearch.length === 0) {
    throw new Error("Databricks documentation contained no native web-search models");
  }
  return {
    generatedAt,
    capabilities: { responses, imageInput, applyPatch, webSearch },
  };
}

/** Parse pay-per-token limits from Databricks Foundation Model API HTML. */
export function parseModelRateLimits(html: string, generatedAt: number): ModelRateLimitsSnapshot {
  const $ = load(html);
  const models: Record<string, ModelRateLimitCatalogue["models"][string]> = {};
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const headers = $(rows.get(0))
      .find("th, td")
      .toArray()
      .map((cell) => collapseText($(cell)).toLowerCase());
    const modelIndex = headers.findIndex((value) => value.includes("model"));
    const inputIndex = headers.findIndex((value) => value.includes("itpm"));
    const outputIndex = headers.findIndex((value) => value.includes("otpm"));
    const queryIndex = headers.findIndex((value) => value.includes("qph"));
    if (modelIndex < 0 || inputIndex < 0 || outputIndex < 0) return;
    rows.slice(1).each((__, row) => {
      const cells = $(row)
        .find("th, td")
        .toArray()
        .map((cell) => collapseText($(cell)));
      const key = modelKey(cells[modelIndex]);
      if (!key) return;
      models[key] = {
        inputTokensPerMinute: number(cells[inputIndex]),
        outputTokensPerMinute: number(cells[outputIndex]),
        queriesPerHour: queryIndex < 0 ? null : number(cells[queryIndex]),
      };
    });
  });
  if (Object.keys(models).length === 0) {
    throw new Error("Databricks model-limit documentation contained no models");
  }
  return { generatedAt, catalogue: { models: sortRecord(models) } };
}

/** Parse reasoning-effort ladders from the Query reasoning models HTML table. */
export function parseReasoningModels(
  html: string,
  generatedAt: number,
): ReasoningModelsSnapshot {
  const $ = load(html);
  const models: Record<string, ReasoningLevel[]> = {};
  $("table").each((_, table) => {
    const rows = $(table).find("tr");
    const headers = $(rows.get(0))
      .find("th, td")
      .toArray()
      .map((cell) => collapseText($(cell)).toLowerCase());
    if (!headers.some((header) => header.includes("model"))) return;
    if (!headers.some((header) => header.includes("parameter"))) return;
    rows.slice(1).each((__, row) => {
      const cells = $(row).find("th, td").toArray().map((cell) => $(cell));
      if (cells.length < 2) return;
      const modelNames = reasoningModelNamesFromCell(cells[0]!, $);
      if (modelNames.length === 0) return;
      const parametersText = collapseText(cells[cells.length - 1]!);
      const perModel = reasoningLevelsByModelSection(parametersText, modelNames);
      if (Object.keys(perModel).length > 0) {
        for (const [key, levels] of Object.entries(perModel)) {
          if (levels.length > 0) models[key] = sortReasoningLevels(levels);
        }
        return;
      }
      const shared = sortReasoningLevels(extractAcceptedReasoningLevels(parametersText));
      if (shared.length === 0) return;
      for (const name of modelNames) {
        const key = modelKey(name);
        if (key) models[key] = shared;
      }
    });
  });
  if (Object.keys(models).length === 0) {
    throw new Error("Databricks reasoning documentation contained no model effort ladders");
  }
  return { generatedAt, catalogue: { models: sortRecord(models) } };
}

function reasoningModelNamesFromCell(cell: Selection, $: CheerioAPI): string[] {
  const names = new Set<string>();
  cell.find("code").each((_, code) => {
    const text = collapseText($(code));
    if (text.startsWith("databricks-")) names.add(text);
  });
  if (names.size === 0) {
    for (const match of collapseText(cell).matchAll(MODEL_CODE_PATTERN)) {
      names.add(match[0]!);
    }
  }
  return [...names];
}

function extractAcceptedReasoningLevels(text: string): ReasoningLevel[] {
  const levels: ReasoningLevel[] = [];
  for (const match of text.matchAll(ACCEPTED_VALUES_PATTERN)) {
    const fragment = match[1];
    if (!fragment || /vary by model/i.test(fragment)) continue;
    levels.push(...documentationEffortLevels(fragment));
  }
  return levels;
}

function reasoningLevelsByModelSection(
  parametersText: string,
  rowModels: readonly string[],
): Record<string, ReasoningLevel[]> {
  const result: Record<string, ReasoningLevel[]> = {};
  for (const match of parametersText.matchAll(FOR_MODEL_PATTERN)) {
    const label = match[1]?.trim();
    const fragment = match[2];
    if (!label || !fragment) continue;
    const levels = uniqueReasoningLevels(documentationEffortLevels(fragment));
    if (levels.length === 0) continue;
    const matched = rowModels.filter((model) => reasoningModelLabelMatches(label, model));
    // Only attach explicit "For <model>" clauses to models listed in the row.
    if (matched.length === 0) continue;
    for (const target of matched) {
      const key = modelKey(target);
      if (key) result[key] = sortReasoningLevels(levels);
    }
  }
  return result;
}

function documentationEffortLevels(fragment: string): ReasoningLevel[] {
  return reasoningTokensFromFragment(fragment).flatMap((token) => {
    const normalized = token.toLowerCase().replace(/[_\s]+/g, "-");
    if (
      !DOCUMENTATION_EFFORT_TOKENS.has(normalized) &&
      !DOCUMENTATION_EFFORT_TOKENS.has(token.toLowerCase())
    ) {
      return [];
    }
    const level = parseReasoning(token);
    return level ? [level] : [];
  });
}

function sortReasoningLevels(levels: readonly ReasoningLevel[]): ReasoningLevel[] {
  return uniqueReasoningLevels(levels).sort(
    (left, right) => REASONING_LEVELS.indexOf(left) - REASONING_LEVELS.indexOf(right),
  );
}

function reasoningModelLabelMatches(label: string, model: string): boolean {
  const left = label
    .toLowerCase()
    .replace(/^databricks-/, "")
    .replace(/[^a-z0-9]+/g, "");
  const right = model
    .toLowerCase()
    .replace(/^databricks-/, "")
    .replace(/[^a-z0-9]+/g, "");
  return left === right || right.includes(left) || left.includes(right);
}

function reasoningTokensFromFragment(fragment: string): string[] {
  const tokens: string[] = [];
  for (const part of fragment.matchAll(TOKEN_PATTERN)) {
    const token = part[1] ?? part[2] ?? part[3] ?? part[4];
    if (!token || token === "and" || token === "or" || token === "of") continue;
    tokens.push(token.replace(/^["'`]+|["'`]+$/g, ""));
  }
  return tokens;
}

function modelsAfterHeading($: CheerioAPI, headingId: string): string[] {
  return [
    ...new Set(codeValuesAfterHeading($, headingId).flatMap((value) => modelKey(value) ?? [])),
  ].sort();
}

function nativeWebSearchModels($: CheerioAPI, responses: readonly string[]): string[] {
  const families = new Set<string>();
  const models = new Set<string>();
  let nativeSection = false;
  for (const element of sectionElements($, "supported-models")) {
    if (headingLevel(nodeTagName(element.get(0))) !== undefined) {
      nativeSection = !collapseText(element).toLowerCase().includes("via mcp");
      continue;
    }
    if (!nativeSection) continue;
    const values = nodeTagName(element.get(0)) === "code" ? [collapseText(element)] : [];
    element.find("code").each((_, code) => {
      values.push(collapseText($(code)));
    });
    for (const value of values) {
      const model = modelKey(value);
      if (!model) continue;
      models.add(model);
      families.add(model.split("-", 1)[0]);
    }
  }
  for (const model of responses) {
    if (families.has(model.split("-", 1)[0])) models.add(model);
  }
  return [...models].sort();
}

function codeValuesAfterHeading($: CheerioAPI, headingId: string): string[] {
  const values: string[] = [];
  for (const element of sectionElements($, headingId)) {
    if (nodeTagName(element.get(0)) === "code") values.push(collapseText(element));
    element.find("code").each((_, code) => {
      values.push(collapseText($(code)));
    });
  }
  return values;
}

function sectionElements($: CheerioAPI, headingId: string): Selection[] {
  const heading = $(`#${headingId}`).first();
  if (heading.length === 0)
    throw new Error(`Databricks capability page is missing section ${headingId}`);
  const level = headingLevel(nodeTagName(heading.get(0)));
  if (level === undefined)
    throw new Error(`Databricks capability section ${headingId} is not a heading`);
  const elements: Selection[] = [];
  let sibling = heading.next();
  while (sibling.length > 0) {
    const siblingLevel = headingLevel(nodeTagName(sibling.get(0)));
    if (siblingLevel !== undefined && siblingLevel <= level) break;
    elements.push(sibling);
    sibling = sibling.next();
  }
  return elements;
}

function headingLevel(name: string | undefined): number | undefined {
  const match = /^h([1-6])$/.exec(name ?? "");
  return match ? Number(match[1]) : undefined;
}

function collapseText(element: Selection): string {
  return element.text().split(/\s+/).filter(Boolean).join(" ");
}

function nodeTagName(node: unknown): string | undefined {
  if (!node || typeof node !== "object" || !("tagName" in node)) return undefined;
  return typeof node.tagName === "string" ? node.tagName : undefined;
}

function modelKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let name = value.trim().replace(/\*+$/, "").trim();
  for (const suffix of ["(Public Preview)", "(Beta)", "(Preview)"]) {
    if (name.endsWith(suffix)) name = name.slice(0, -suffix.length).trim();
  }
  return modelSearchQuery(name)?.replaceAll(" ", "-");
}

function number(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
