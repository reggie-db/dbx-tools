/**
 * LMArena leaderboard catalogue loading from Hugging Face parquet files.
 *
 * @module
 */

import { downloadFile, listFiles, type ListFileEntry } from "@huggingface/hub";
import { parquetReadObjects } from "hyparquet";

/** Hugging Face dataset identifier for the public LMArena leaderboard. */
export const LM_ARENA_DATASET = "lmarena-ai/leaderboard-dataset";

/** LMArena split containing the current published leaderboard snapshots. */
export const LM_ARENA_SPLIT = "latest";

/** Human-readable Hugging Face page for the LMArena leaderboard dataset. */
export const LM_ARENA_DATASET_URL =
  "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";

const LM_ARENA_REPO = { type: "dataset", name: LM_ARENA_DATASET } as const;

/** Rows loaded for one LMArena dataset configuration. */
export interface LMArenaConfigurationData {
  readonly rows: readonly unknown[];
}

/** Complete latest LMArena catalogue loaded from Hugging Face parquet shards. */
export interface LMArenaCatalogData {
  readonly dataset: typeof LM_ARENA_DATASET;
  readonly split: typeof LM_ARENA_SPLIT;
  readonly metadata: readonly ListFileEntry[];
  readonly configurations: Readonly<Record<string, LMArenaConfigurationData>>;
}

/** Load every latest LMArena configuration directly from Hugging Face parquet files. */
export async function loadLMArenaCatalog(): Promise<LMArenaCatalogData> {
  const metadata = await listDatasetFiles();
  const files = latestParquetFiles(metadata);
  const entries = await Promise.all(
    [...files].map(async ([configuration, shards]) => {
      const rows = (
        await Promise.all(
          shards.map(async (shard) => {
            const blob = await downloadFile({ repo: LM_ARENA_REPO, path: shard.path });
            if (!blob) throw new Error(`Hugging Face file not found: ${shard.path}`);
            return parquetReadObjects({ file: await blob.arrayBuffer() });
          }),
        )
      ).flat();
      return [configuration, { rows }] as const;
    }),
  );

  return {
    dataset: LM_ARENA_DATASET,
    split: LM_ARENA_SPLIT,
    metadata,
    configurations: Object.fromEntries(entries),
  };
}

async function listDatasetFiles(): Promise<ListFileEntry[]> {
  const files: ListFileEntry[] = [];
  for await (const file of listFiles({ repo: LM_ARENA_REPO, recursive: true })) {
    files.push(file);
  }
  return files;
}

function latestParquetFiles(value: readonly ListFileEntry[]): Map<string, ListFileEntry[]> {
  const files = new Map<string, ListFileEntry[]>();
  for (const item of value) {
    if (item.type !== "file") continue;
    const configuration = /^([^/]+)\/latest-[^/]+\.parquet$/.exec(item.path)?.[1];
    if (!configuration) continue;
    const shards = files.get(configuration) ?? [];
    shards.push(item);
    files.set(configuration, shards);
  }
  if (files.size === 0) {
    throw new Error("Hugging Face LMArena dataset contained no latest parquet files");
  }
  return new Map(
    [...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([configuration, shards]) => [
        configuration,
        shards.sort((left, right) => left.path.localeCompare(right.path)),
      ]),
  );
}
