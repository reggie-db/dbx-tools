/**
 * Browser-safe model contracts and runtime schemas.
 *
 * @module
 */

import {
  type EndpointCapabilities as GeneratedEndpointCapabilities,
  type FamilyClass as GeneratedFamilyClass,
  ModelClass as GeneratedModelClass,
  type ModelCapabilities as GeneratedModelCapabilities,
  type ModelMetadata as GeneratedModelMetadata,
  ReasoningEffort as GeneratedReasoningEffort,
  type ModelClass as GeneratedModelClassType,
  type ModelProfile as GeneratedModelProfile,
  type ModelQuery as GeneratedModelQuery,
  type ModelRateLimits as GeneratedModelRateLimits,
  type ModelStatus as GeneratedModelStatus,
  type RankedModel as GeneratedRankedModel,
  type ReasoningEffort as GeneratedReasoningEffortType,
  type ResolvedModel as GeneratedResolvedModel,
  type ResolvedModelSelection as GeneratedResolvedModelSelection,
  type ResolveModelInput as GeneratedResolveModelInput,
  type ResolveModelOptions as GeneratedResolveModelOptions,
  type ScoredEndpoint as GeneratedScoredEndpoint,
  type ServingEndpointSummary as GeneratedServingEndpointSummary,
} from "./contracts.ts";
import {
  endpointCapabilitiesSchema,
  familyClassSchema,
  modelClassSchema,
  modelCapabilitiesSchema,
  modelMetadataSchema,
  modelProfileSchema,
  modelQuerySchema,
  modelRateLimitsSchema,
  modelStatusSchema,
  rankedModelSchema,
  reasoningEffortSchema,
  resolvedModelSchema,
  resolvedModelSelectionSchema,
  resolveModelInputSchema,
  resolveModelOptionsSchema,
  scoredEndpointSchema,
  servingEndpointSummarySchema,
} from "./generated/_schemas.ts";

/** Capabilities derived from one normalized endpoint. */
export type EndpointCapabilities = GeneratedEndpointCapabilities;
/** Family fallback classification for an unscored model. */
export type FamilyClass = GeneratedFamilyClass;
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
/** Published model capability metadata. */
export type ModelCapabilities = GeneratedModelCapabilities;
/** Combined model metadata. */
export type ModelMetadata = GeneratedModelMetadata;
/** Published model rate limits. */
export type ModelRateLimits = GeneratedModelRateLimits;
/** Model lifecycle status. */
export type ModelStatus = GeneratedModelStatus;
/** A ranked endpoint result. */
export type RankedModel = GeneratedRankedModel;
/** Provider wire value accepted as a reasoning effort. */
export type ReasoningEffort = GeneratedReasoningEffortType;
/** Fuzzy endpoint resolution result. */
export type ResolvedModel = GeneratedResolvedModel;
/** Selected model and policy source. */
export type ResolvedModelSelection = GeneratedResolvedModelSelection;
/** Model selection intent. */
export type ResolveModelInput = GeneratedResolveModelInput;
/** Fuzzy endpoint resolution controls. */
export type ResolveModelOptions = GeneratedResolveModelOptions;
/** Endpoint plus fuzzy-match score. */
export type ScoredEndpoint = GeneratedScoredEndpoint;
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

/** Runtime schema for endpoint capabilities. */
export const EndpointCapabilitiesSchema = endpointCapabilitiesSchema;
/** Runtime schema for a family fallback classification. */
export const FamilyClassSchema = familyClassSchema;
/** Runtime schema for documented model capabilities. */
export const ModelCapabilitiesSchema = modelCapabilitiesSchema;
/** Runtime schema for combined model metadata. */
export const ModelMetadataSchema = modelMetadataSchema;
/** Runtime schema for published model rate limits. */
export const ModelRateLimitsSchema = modelRateLimitsSchema;
/** Runtime schema for a fuzzy endpoint resolution result. */
export const ResolvedModelSchema = resolvedModelSchema;
/** Runtime schema for fuzzy endpoint resolution controls. */
export const ResolveModelOptionsSchema = resolveModelOptionsSchema;
/** Runtime schema for an endpoint plus fuzzy score. */
export const ScoredEndpointSchema = scoredEndpointSchema;
/** Runtime schema for model selection intent. */
export const ResolveModelInputSchema = resolveModelInputSchema;
/** Runtime schema for a selected model and policy source. */
export const ResolvedModelSelectionSchema = resolvedModelSelectionSchema;
