import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_METADATA_TTL_MS,
  MODEL_RATE_LIMITS_URL,
  OPENAI_RESPONSES_MODELS_URL,
  RETIRED_MODELS_URL,
  WEB_SEARCH_MODELS_URL,
  type ModelCapabilitiesSnapshot,
  type ModelRateLimitsSnapshot,
  type RetiredModelsSnapshot,
} from "../src/_metadata-contract.ts";
import {
  parseModelCapabilities,
  parseModelRateLimits,
  parseRetiredModels,
} from "../src/_metadata-generator.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const nodeOutput = resolve(repositoryRoot, "packages/js/node/model/src/generated");
const rustCompatibilityOutput = resolve(repositoryRoot, "packages/rs/model/assets");
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
]);

async function refreshSnapshot<T extends { readonly generatedAt: number }>(
  filename: string,
  loadSnapshot: () => Promise<T>,
): Promise<void> {
  const primaryPath = resolve(nodeOutput, filename);
  const compatibilityPath = resolve(rustCompatibilityOutput, filename);
  const existing =
    (await readSnapshot<T>(primaryPath)) ?? (await readSnapshot<T>(compatibilityPath));
  if (existing && now - existing.generatedAt < MODEL_METADATA_TTL_MS / 1000) {
    await writeSnapshot(primaryPath, existing);
    await writeSnapshot(compatibilityPath, existing);
    console.log(`${filename}: current`);
    return;
  }
  try {
    const snapshot = await loadSnapshot();
    await writeSnapshot(primaryPath, snapshot);
    await writeSnapshot(compatibilityPath, snapshot);
    console.log(`${filename}: refreshed`);
  } catch (error) {
    if (!existing) throw error;
    await writeSnapshot(primaryPath, existing);
    await writeSnapshot(compatibilityPath, existing);
    console.warn(`${filename}: refresh failed; retained committed snapshot`, error);
  }
}

async function loadPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "dbx-tools-model-metadata/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Databricks documentation returned HTTP ${response.status}: ${url}`);
  return response.text();
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
