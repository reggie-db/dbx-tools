/**
 * Top-level AppKit memory plugin configuration.
 *
 * @module
 */

import type { BasePluginConfig } from "@databricks/appkit";
import { projectUtils } from "@dbx-tools/core";
import { toSlugWithOptions } from "@dbx-tools/shared-core";
import {
  GraphitiOptionsSchema,
  graphitiOptionOverrides,
  type GraphitiOptions,
} from "@dbx-tools/shared-graphiti";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

export const DatabricksMemoryOptionsSchema = z
  .object({
    memoryStore: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Existing Databricks Agent Memory Store id or resource name."),
    mode: z
      .enum(["auto", "required"])
      .default("auto")
      .describe("Whether an inaccessible managed-memory store falls back or fails."),
  })
  .strict()
  .describe("Databricks managed-memory backend configuration.");

export type DatabricksMemoryOptions = z.input<typeof DatabricksMemoryOptionsSchema>;

const GraphitiMemoryOptionsSchema = GraphitiOptionsSchema.partial().describe(
  "Graphiti option overrides for the lazy fallback.",
);

export const MemoryPluginOptionsSchema = z
  .object({
    databricks: z
      .union([z.literal("auto"), z.boolean(), DatabricksMemoryOptionsSchema])
      .default("auto")
      .describe(
        "Databricks managed memory mode: auto falls back, true requires access, and false disables it.",
      ),
    graphiti: z
      .union([z.boolean(), GraphitiMemoryOptionsSchema])
      .default(true)
      .describe("Lazy Graphiti fallback configuration, enabled by default."),
    saveTurns: z
      .union([z.literal("auto"), z.boolean()])
      .default("auto")
      .describe(
        "Completed-turn saving mode: auto mirrors only through an already-running Graphiti fallback, true may start Graphiti and requires attachment, and false disables it.",
      ),
  })
  .strict()
  .describe("AppKit memory plugin options.");

export type MemoryPluginOptions = z.input<typeof MemoryPluginOptionsSchema>;

/** AppKit base configuration plus the memory plugin's serialized options. */
export type MemoryPluginConfig = BasePluginConfig & MemoryPluginOptions;

/** Resolved Databricks store identity and availability policy. */
export interface ResolvedDatabricksMemoryOptions {
  readonly memoryStore: string;
  readonly mode: "auto" | "required";
}

/** Fully resolved top-level memory configuration. */
export interface ResolvedMemoryPluginConfig {
  readonly databricks: false | ResolvedDatabricksMemoryOptions;
  readonly graphiti: false | GraphitiOptions;
  readonly saveTurns: "auto" | boolean;
}

/** JSON Schema published through the AppKit memory plugin manifest. */
export const MEMORY_CONFIG_SCHEMA = z.toJSONSchema(MemoryPluginOptionsSchema) as JSONSchema7;

/** Resolve plugin defaults without parsing unrelated AppKit base fields. */
export function resolveMemoryPluginConfig(
  config: MemoryPluginConfig = {},
): ResolvedMemoryPluginConfig {
  const parsed = MemoryPluginOptionsSchema.parse({
    databricks: config.databricks,
    graphiti: config.graphiti,
    saveTurns: config.saveTurns,
  });
  if (parsed.databricks === false && parsed.graphiti === false) {
    throw new Error("AppKit memory requires at least one enabled backend");
  }
  return {
    databricks:
      parsed.databricks === false
        ? false
        : {
            memoryStore:
              typeof parsed.databricks === "object" && parsed.databricks.memoryStore
                ? resourceId(parsed.databricks.memoryStore, "memory-stores")
                : defaultMemoryStore(),
            mode:
              parsed.databricks === true
                ? "required"
                : typeof parsed.databricks === "object"
                  ? parsed.databricks.mode
                  : "auto",
          },
    graphiti:
      config.graphiti === false
        ? false
        : config.graphiti === undefined || config.graphiti === true
          ? {}
          : graphitiOptionOverrides(config.graphiti),
    saveTurns: parsed.saveTurns,
  };
}

function defaultMemoryStore(): string {
  const slug = toSlugWithOptions({ maxLength: 56, truncateStrategy: "hash" }, projectUtils.name());
  const id = /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  return (id.length < 3 ? `${id}-store` : id).slice(0, 56);
}

function resourceId(value: string, prefix: string): string {
  const trimmed = value.trim().replace(new RegExp(`^${prefix}/`), "");
  if (!trimmed) throw new Error(`${prefix} id is required`);
  return trimmed;
}
