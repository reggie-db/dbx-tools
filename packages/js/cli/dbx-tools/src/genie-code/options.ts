/**
 * CLI projection of the shared managed Genie Code options.
 *
 * @module
 */

export {
  GenieCodeOptionsSchema as GenieCodeCliOptionsSchema,
  resolveGenieCodeOptions as resolveGenieCodeCliOptions,
} from "@dbx-tools/shared-genie-code/options";
export type {
  GenieCodeOptions as GenieCodeCliOptions,
  ResolvedGenieCodeOptions as ResolvedGenieCodeCliOptions,
} from "@dbx-tools/shared-genie-code/options";
