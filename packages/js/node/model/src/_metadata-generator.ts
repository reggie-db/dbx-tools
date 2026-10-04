import { load, type CheerioAPI } from "cheerio";

import type {
  ModelCapabilitiesSnapshot,
  ModelRateLimitCatalogue,
  ModelRateLimitsSnapshot,
  RetiredModelsSnapshot,
} from "./_metadata-contract.ts";
import { modelSearchQuery } from "./policy.ts";

type Selection = ReturnType<CheerioAPI>;

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
  const webSearch = modelsAfterHeading(load(webSearchHtml), "openai-models");
  if (webSearch.length === 0) {
    throw new Error("Databricks documentation contained no OpenAI web-search models");
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

function modelsAfterHeading($: CheerioAPI, headingId: string): string[] {
  return [
    ...new Set(codeValuesAfterHeading($, headingId).flatMap((value) => modelKey(value) ?? [])),
  ].sort();
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
