/**
 * Browser-safe Smart Router constants and Databricks routing-wire contracts.
 *
 * @module
 */

import { z } from "zod";

/** Canonical virtual model id that invokes Databricks Smart Router. */
export const SMART_ROUTER_MODEL_ID = "smart-router";

/** Databricks task router used for coding-agent model selection. */
export const SMART_ROUTER_NAME = "task_v3";

/** Concrete endpoint selected for a Smart Router request. */
export const SMART_ROUTER_SELECTED_MODEL_HEADER = "x-dbx-tools-smart-router-model";

/** Router arm returned by Databricks before endpoint resolution. */
export const SMART_ROUTER_ROUTE_MODEL_HEADER = "x-dbx-tools-smart-router-route-model";

/** Coding-agent harness policy used for a Smart Router request. */
export const SMART_ROUTER_HARNESS_HEADER = "x-dbx-tools-smart-router-harness";

/** Runtime source that produced the Smart Router decision. */
export const SMART_ROUTER_SOURCE_HEADER = "x-dbx-tools-smart-router-source";

/** Task tier reported by task_v3 when present. */
export const SMART_ROUTER_TASK_TIER_HEADER = "x-dbx-tools-smart-router-task-tier";

/** Served tier reported by task_v3 when present. */
export const SMART_ROUTER_SERVED_TIER_HEADER = "x-dbx-tools-smart-router-served-tier";

/** task_v3 profiler status when present. */
export const SMART_ROUTER_PROFILER_STATUS_HEADER = "x-dbx-tools-smart-router-profiler-status";

/** Harness vocabulary accepted by Databricks Smart Router. */
export const SmartRouterHarnessSchema = z
  .enum(["codex", "claude"])
  .describe("Coding-agent harness policy applied to one Smart Router route option.");

export type SmartRouterHarness = z.infer<typeof SmartRouterHarnessSchema>;

/** One concrete model offered to Databricks Smart Router. */
export const SmartRouterRouteOptionSchema = z
  .object({
    model: z
      .string()
      .trim()
      .min(1)
      .describe("Databricks system model service offered to the router."),
    harness: SmartRouterHarnessSchema,
  })
  .strict()
  .describe("One eligible Smart Router route option.");

export type SmartRouterRouteOption = z.infer<typeof SmartRouterRouteOptionSchema>;

/** Databricks routes:select request body. */
export const SmartRouterRequestSchema = z
  .object({
    route_options: z
      .array(SmartRouterRouteOptionSchema)
      .min(1)
      .describe("Eligible concrete system-model routes."),
    task: z
      .object({
        prompt: z
          .string()
          .trim()
          .min(1)
          .describe("Bounded task context classified by Smart Router."),
      })
      .strict(),
    route_selector: z
      .object({
        router_name: z.string().trim().min(1).describe("Configured Databricks router name."),
      })
      .strict(),
  })
  .strict()
  .describe("Validated Databricks Smart Router selection request.");

export type SmartRouterRequest = z.infer<typeof SmartRouterRequestSchema>;

/** One selected route returned by Databricks routes:select. */
export const SmartRouterRouteSelectionSchema = z
  .object({
    route_option: z
      .object({
        model: z.string().trim().min(1),
        harness: SmartRouterHarnessSchema.optional(),
      })
      .passthrough(),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Router-specific profiling and policy metadata."),
  })
  .passthrough()
  .describe("One Smart Router route selection and its profiling metadata.");

export type SmartRouterRouteSelection = z.infer<typeof SmartRouterRouteSelectionSchema>;

/** Databricks routes:select response body. */
export const SmartRouterResponseSchema = z
  .object({
    route_selection: z.array(SmartRouterRouteSelectionSchema).min(1),
    rationale: z.string().optional(),
  })
  .passthrough()
  .describe("Validated Databricks Smart Router response.");

export type SmartRouterResponse = z.infer<typeof SmartRouterResponseSchema>;

/** Persistable result of one Smart Router decision. */
export const SmartRouterObservationSchema = z
  .object({
    selectedModel: z.string().min(1).describe("Concrete serving endpoint selected for the turn."),
    routeModel: z.string().min(1).describe("Model service returned by Databricks Smart Router."),
    harness: SmartRouterHarnessSchema,
    routerName: z.string().min(1),
    source: z.enum(["router", "cache"]),
    rationale: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .describe("Persistable and observable Smart Router result.");

export type SmartRouterObservation = z.infer<typeof SmartRouterObservationSchema>;

/** Match the canonical Smart Router id with an optional dbx/databricks namespace. */
export function isSmartRouterModelId(value: string | undefined): boolean {
  return (
    value
      ?.trim()
      .replace(/^(?:dbx|databricks)\//i, "")
      .toLowerCase() === SMART_ROUTER_MODEL_ID
  );
}
