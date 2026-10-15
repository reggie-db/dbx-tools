/**
 * Standalone Genie space assembly for no-dashboard generator runs.
 *
 * @module
 */

import { ExecutionError } from "@databricks/appkit";
import { databricks } from "@dbx-tools/appkit";
import { createGenieSpace } from "@dbx-tools/genie/space";
import { hash } from "@dbx-tools/shared-core";
import {
  GeneratedGenieSpaceSchema,
  type GeneratedGenieSpace,
  type GeneratedSchema,
  type GeneratorPlan,
} from "@dbx-tools/shared-generator/workflow";
import { resolveGeneratorIdentity } from "./namespace.ts";

/** Inputs for one standalone generated Genie space. */
export interface CreateGeneratorGenieInput {
  /** Generated schema containing the fact table. */
  location: GeneratedSchema;
  /** Validated data and KPI plan. */
  plan: GeneratorPlan;
  /** SQL warehouse associated with the space. */
  warehouseId: string;
  /** Company display name. */
  company: string;
  /** Demo purpose. */
  purpose: string;
}

/** Create the serialized space definition consumed by the GA create endpoint. */
export function buildGeneratorGenieSpace(input: CreateGeneratorGenieInput) {
  const table = `${input.location.catalog}.${input.location.schema}.${input.plan.table}`;
  const id = () => hash.id().replaceAll("-", "");
  return {
    version: 1,
    config: {
      sample_questions: input.plan.sampleQuestions.map((question) => ({
        id: id(),
        question: [question],
      })),
    },
    data_sources: {
      tables: [
        {
          identifier: table,
          description: [input.plan.story],
        },
      ],
    },
    instructions: {
      text_instructions: [
        {
          id: id(),
          content: [
            `Answer questions about ${input.company} for ${input.purpose}.`,
            input.plan.story,
          ],
        },
      ],
      sql_snippets: {
        measures: input.plan.metrics.map((metric) => ({
          id: id(),
          alias: metric.name,
          display_name: metric.label,
          sql: [
            metric.aggregation === "count"
              ? "COUNT(*)"
              : `${metric.aggregation === "sum" ? "SUM" : "AVG"}(${metric.column})`,
          ],
        })),
      },
    },
  };
}

/** Create a standalone Genie space as the active OBO user. */
export async function createGeneratorGenieSpace(
  input: CreateGeneratorGenieInput,
  signal?: AbortSignal,
): Promise<GeneratedGenieSpace> {
  const identity = await resolveGeneratorIdentity();
  if (identity.principal !== input.location.principal) {
    throw new ExecutionError("Genie principal does not match the active OBO user");
  }
  const parentPath = `/Workspace/Users/${identity.principal}/.dbx-tools/generator/${input.location.schema}`;
  const context = signal ? databricks.toContext(signal) : undefined;
  await identity.userClient
    .toLegacyWorkspaceClient()
    .workspace.mkdirs({ path: parentPath }, context);
  const title = `${input.company} ${input.purpose}`;
  const created = await createGenieSpace(
    {
      warehouse_id: input.warehouseId,
      title,
      description: input.plan.story,
      parent_path: parentPath,
      serialized_space: JSON.stringify(buildGeneratorGenieSpace(input)),
    },
    {
      workspaceClient: identity.userClient,
      ...(signal ? { context: signal } : {}),
    },
  );
  return GeneratedGenieSpaceSchema.parse({
    spaceId: created.space_id,
    title: created.title || title,
  });
}
