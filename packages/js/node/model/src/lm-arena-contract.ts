/**
 * Lightweight LMArena dataset contracts shared by metadata parsing and loading.
 *
 * @module
 */

import type { ListFileEntry } from "@huggingface/hub";

/** Hugging Face dataset identifier for the public LMArena leaderboard. */
export const LM_ARENA_DATASET = "lmarena-ai/leaderboard-dataset";

/** LMArena split containing the current published leaderboard snapshots. */
export const LM_ARENA_SPLIT = "latest";

/** Human-readable Hugging Face page for the LMArena leaderboard dataset. */
export const LM_ARENA_DATASET_URL =
  "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";

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
