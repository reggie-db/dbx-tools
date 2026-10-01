/**
 * Browser-safe model contracts generated from the Rust model owner.
 *
 * Rust owns record fields, enum wire values, and field validation metadata.
 * This module preserves the established public names while keeping native FFI
 * initialization out of browser bundles.
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
} from "./generated/_contracts.ts";
import {
  modelClassSchema,
  modelProfileSchema,
  modelQuerySchema,
  modelStatusSchema,
  rankedModelSchema,
  reasoningEffortSchema,
  servingEndpointSummarySchema,
} from "./generated/_schemas.ts";

/** Runtime values for the Rust-owned model class contract. */
export const ModelClass = GeneratedModelClass;
/** Class of a Databricks Model Serving endpoint. */
export type ModelClass = GeneratedModelClassType;
/** Runtime values for the Rust-owned reasoning effort contract. */
export const ReasoningEffortValues = GeneratedReasoningEffort;
/** Databricks AI Gateway profile scores. */
export type ModelProfile = GeneratedModelProfile;
/** Model catalogue query controls. */
export type ModelQuery = GeneratedModelQuery;
/** Model lifecycle status. */
export type ModelStatus = GeneratedModelStatus;
/** A Rust-ranked endpoint result. */
export type RankedModel = GeneratedRankedModel;
/** Provider wire value accepted as a reasoning effort. */
export type ReasoningEffort = GeneratedReasoningEffortType;
/** Normalized metadata for a Databricks Model Serving endpoint. */
export type ServingEndpointSummary = GeneratedServingEndpointSummary;

/** Runtime schema for the Rust-owned model class wire values. */
export const ModelClassSchema = modelClassSchema.describe(
  `Endpoint class slug: ${Object.values(GeneratedModelClass).join(", ")}.`,
);

/** Runtime schema for Rust-owned Databricks AI Gateway profile scores. */
export const ModelProfileSchema = modelProfileSchema;

/** Runtime schema for Rust-owned reasoning effort wire values. */
export const ReasoningEffortSchema = reasoningEffortSchema;

/** Runtime schema for Rust-owned model lifecycle status. */
export const ModelStatusSchema = modelStatusSchema;

/** Runtime schema for Rust-owned normalized endpoint metadata. */
export const ServingEndpointSummarySchema = servingEndpointSummarySchema;

/** Runtime schema for Rust-owned model catalogue query controls. */
export const ModelQuerySchema = modelQuerySchema;

/** Runtime schema for a Rust-ranked endpoint result. */
export const RankedModelSchema = rankedModelSchema;
