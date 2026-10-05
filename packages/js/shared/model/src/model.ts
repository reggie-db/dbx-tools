/**
 * Browser-safe model contracts and runtime schemas.
 *
 * @module
 */

import {
  ModelClass as GeneratedModelClass,
  ReasoningEffort as GeneratedReasoningEffort,
  type ModelClass as GeneratedModelClassType,
  type ModelProfile as GeneratedModelProfile,
  type ModelQuery as GeneratedModelQuery,
  type ModelStatus as GeneratedModelStatus,
  type RankedModel as GeneratedRankedModel,
  type ReasoningEffort as GeneratedReasoningEffortType,
  type ServingEndpointSummary as GeneratedServingEndpointSummary,
} from "./contracts.ts";
import {
  modelClassSchema,
  modelProfileSchema,
  modelQuerySchema,
  modelStatusSchema,
  rankedModelSchema,
  reasoningEffortSchema,
  servingEndpointSummarySchema,
} from "./generated/_schemas.ts";

/** Runtime values for the model class contract. */
export const ModelClass = GeneratedModelClass;
/** Class of a Databricks Model Serving endpoint. */
export type ModelClass = GeneratedModelClassType;
/** Runtime values for the reasoning effort contract. */
export const ReasoningEffortValues = GeneratedReasoningEffort;
/** Databricks AI Gateway profile scores. */
export type ModelProfile = GeneratedModelProfile;
/** Model catalogue query controls. */
export type ModelQuery = GeneratedModelQuery;
/** Model lifecycle status. */
export type ModelStatus = GeneratedModelStatus;
/** A ranked endpoint result. */
export type RankedModel = GeneratedRankedModel;
/** Provider wire value accepted as a reasoning effort. */
export type ReasoningEffort = GeneratedReasoningEffortType;
/** Normalized metadata for a Databricks Model Serving endpoint. */
export type ServingEndpointSummary = GeneratedServingEndpointSummary;

/** Runtime schema for model class wire values. */
export const ModelClassSchema = modelClassSchema.describe(
  `Endpoint class slug: ${Object.values(GeneratedModelClass).join(", ")}.`,
);

/** Runtime schema for Databricks AI Gateway profile scores. */
export const ModelProfileSchema = modelProfileSchema;

/** Runtime schema for reasoning effort wire values. */
export const ReasoningEffortSchema = reasoningEffortSchema;

/** Runtime schema for model lifecycle status. */
export const ModelStatusSchema = modelStatusSchema;

/** Runtime schema for normalized endpoint metadata. */
export const ServingEndpointSummarySchema = servingEndpointSummarySchema;

/** Runtime schema for model catalogue query controls. */
export const ModelQuerySchema = modelQuerySchema;

/** Runtime schema for a ranked endpoint result. */
export const RankedModelSchema = rankedModelSchema;
