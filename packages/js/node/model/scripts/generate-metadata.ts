import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  databricksGenAiCalculatorAssetUrl,
  parseModelParams,
  parseModelCapabilities,
  parseModelRateLimits,
  parseModelTokenPrices,
  parseModelsDev,
  parseReasoningModels,
  parseRetiredModels,
} from "../src/_metadata-generator.ts";
import {
  MODELPARAMS_DEV_MODELS_URL,
  MODELS_DEV_API_URL,
  GENAI_PRICING_CALCULATOR_URL,
  MODEL_METADATA_TTL_MS,
  MODEL_RATE_LIMITS_URL,
  FOUNDATION_MODEL_PRICING_URL,
  OPENAI_RESPONSES_MODELS_URL,
  PROPRIETARY_MODEL_PRICING_URL,
  QUERY_REASON_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
  type ModelParamsSnapshot,
  type ModelCapabilitiesSnapshot,
  type ModelRateLimitsSnapshot,
  type ModelTokenPricesSnapshot,
  type ModelsDevSnapshot,
  type ReasoningModelsSnapshot,
  type RetiredModelsSnapshot,
} from "../src/metadata-contract.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const nodeOutput = resolve(repositoryRoot, "packages/js/node/model/src/generated");
const now = Math.floor(Date.now() / 1000);

await Promise.all([
  refreshSnapshot<RetiredModelsSnapshot>("retired-models.json", async () =>
    parseRetiredModels(await loadPage(RETIRED_MODELS_URL), now),
  ),
  refreshSnapshot<ModelCapabilitiesSnapshot>("model-capabilities.json", async () => {
    const [responsesHtml, webSearchHtml] = await Promise.all([
      loadPage(OPENAI_RESPONSES_MODELS_URL),
      loadPage(WEB_SEARCH_MODELS_URL),
    ]);
    return parseModelCapabilities(responsesHtml, webSearchHtml, now);
  }),
  refreshSnapshot<ModelRateLimitsSnapshot>("model-rate-limits.json", async () =>
    parseModelRateLimits(await loadPage(MODEL_RATE_LIMITS_URL), now),
  ),
  refreshSnapshot<ModelTokenPricesSnapshot>("model-token-prices.json", async () => {
    const [foundationHtml, proprietaryHtml, calculatorHtml] = await Promise.all([
      loadPage(FOUNDATION_MODEL_PRICING_URL),
      loadPage(PROPRIETARY_MODEL_PRICING_URL),
      loadPage(GENAI_PRICING_CALCULATOR_URL),
    ]);
    const calculatorJavascript = await loadPage(
      databricksGenAiCalculatorAssetUrl(calculatorHtml, GENAI_PRICING_CALCULATOR_URL),
    );
    return parseModelTokenPrices(foundationHtml, proprietaryHtml, now, calculatorJavascript);
  }),
  refreshSnapshot<ReasoningModelsSnapshot>("model-reasoning.json", async () =>
    parseReasoningModels(await loadPage(QUERY_REASON_MODELS_URL), now),
  ),
  refreshSnapshot<ModelsDevSnapshot>("models-dev-capabilities.json", async () =>
    parseModelsDev(await loadJson(MODELS_DEV_API_URL), now),
  ),
  refreshSnapshot<ModelParamsSnapshot>("modelparams-reasoning.json", async () =>
    parseModelParams(await loadJson(MODELPARAMS_DEV_MODELS_URL), now),
  ),
]);

async function refreshSnapshot<T extends { readonly generatedAt: number }>(
  filename: string,
  loadSnapshot: () => Promise<T>,
): Promise<void> {
  const primaryPath = resolve(nodeOutput, filename);
  const existing = await readSnapshot<T>(primaryPath);
  if (existing && now - existing.generatedAt < MODEL_METADATA_TTL_MS / 1000) {
    await writeSnapshot(primaryPath, existing);
    console.log(`${filename}: current`);
    return;
  }
  try {
    const snapshot = await loadSnapshot();
    await writeSnapshot(primaryPath, snapshot);
    console.log(`${filename}: refreshed`);
  } catch (error) {
    if (!existing) throw error;
    await writeSnapshot(primaryPath, existing);
    console.warn(`${filename}: refresh failed; retained committed snapshot`, error);
  }
}

async function loadPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "dbx-tools-model-metadata/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Databricks documentation returned HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

async function loadJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": "dbx-tools-model-metadata/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Model metadata source returned HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

async function readSnapshot<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeSnapshot(path: string, snapshot: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporary, path);
}
