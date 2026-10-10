/** Shared Zod option fields for Projen task CLIs. */
import { z } from "zod";

/** Optional repository or workspace root. */
export const TaskRootOptionSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Repository or workspace root");

/** Required project directory. */
export const TaskProjectOptionSchema = z.string().trim().min(1).describe("Project directory");

/** Check generated state without writing changes. */
export const TaskCheckOptionSchema = z
  .boolean()
  .default(false)
  .describe("Check generated state without writing changes");

/** Force work even when fingerprints or generated state appear current. */
export const TaskForceOptionSchema = z
  .boolean()
  .default(false)
  .describe("Force regeneration even when outputs appear current");

/** Keep a task running and react to changes. */
export const TaskWatchOptionSchema = z
  .boolean()
  .default(false)
  .describe("Watch inputs and keep generated state current");

/** Validate publication artifacts without uploading them. */
export const TaskDryRunOptionSchema = z
  .boolean()
  .default(false)
  .describe("Validate artifacts without publishing them");

/** Optional output directory. */
export const TaskOutputOptionSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Output directory");

/** Positive worker concurrency. */
export const TaskConcurrencyOptionSchema = z.coerce
  .number()
  .int()
  .positive()
  .optional()
  .describe("Maximum concurrent workers");

/** Repeatable package or directory selection. */
export const TaskDirectoriesOptionSchema = z
  .array(z.string().trim().min(1))
  .default([])
  .describe("Repeatable package or directory selection");
