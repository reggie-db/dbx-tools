# Public model catalog integration

Date: 2026-11-10

Status: Implemented in source; pending the next dbx-tools release

## Scope

`@dbx-tools/model` now consumes `@dbx-tools/dbx-model-catalog` for public model
metadata. The catalog replaces the runtime documentation and dataset parsing in
`@dbx-tools/model`. Consumers now use the catalog's generated record contracts
directly; workspace-aware selection remains owned by `@dbx-tools/model`.

The catalog reads public documentation and public datasets only. It does not
authenticate to Databricks, call workspace APIs, inspect customer resources, or
determine which models a customer can use.

## Ownership

| Concern                                                                                                                      | Owner                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Public model identities, aliases, lifecycle, pricing, rate limits, documented capabilities, rankings, and latency benchmarks | `@dbx-tools/dbx-model-catalog` |
| Bundled offline public metadata and public HTTP refresh                                                                      | `@dbx-tools/dbx-model-catalog` |
| Workspace endpoint discovery and principal-scoped caching                                                                    | `@dbx-tools/model`             |
| Live task, state, Foundation Model API profile, and embedding-dimension probes                                               | `@dbx-tools/model`             |
| Model classes, selection ceilings, routing, protocol choice, and authentication                                              | `@dbx-tools/model`             |
| Error-learned reasoning ladders                                                                                              | `@dbx-tools/model`             |
| Gateway capability overrides                                                                                                 | Model gateway consumers        |

This split keeps customer-specific data in the workspace client and public facts
in the reusable catalog.

## Runtime precedence

The integration applies the following order:

1. The live workspace endpoint list determines availability.
2. Live endpoint task, state, profile, API capability, and probe results take
   precedence over public metadata.
3. The public catalog adds aliases, lifecycle, pricing, reasoning, rankings,
   rate limits, and benchmark metadata.
4. A live endpoint without a catalog match remains valid and selectable.
5. Public retirement metadata prevents automatic selection by default. An exact
   live endpoint request remains invokable.

This order handles documentation lag without adding workspace access to the
catalog. A newly available customer endpoint appears through the existing
Databricks lookup even when public documentation has not added it yet.

## Parser replacement mapping

| Existing dbx-tools source                                   | Catalog replacement                                       |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| Retirement documentation parser                             | `status`, retirement fields, identities, and aliases      |
| Responses, apply-patch, image-input, and web-search parsers | `capabilities` and `modalities`                           |
| models.dev and modelparams.dev normalization                | normalized capabilities and reasoning efforts             |
| Databricks rate-limit parser                                | `rate_limits`                                             |
| Databricks pricing parser                                   | `average_price.DBU.rates`                                 |
| Public latency benchmark parser                             | `latency`                                                 |
| LMArena dataset loader and percentile conversion            | direct `rankings` records                                 |

The local parsers, generated snapshots, mirror schemas, and compatibility
adapters were removed. `modelCatalogRecordFor()` returns `CatalogModelRecord`
directly. Narrow helpers such as `modelRateLimitsFor()`, `modelLatencyFor()`,
and `modelRankingsFor()` return fields from that record without translating the
shape. Pricing uses the catalog-owned average-price contract.

## Workspace lookup hook

No Databricks lookup hook was added to the catalog because that would violate
its public-only boundary. The hook remains the existing
`listServingEndpoints()` path in `@dbx-tools/model`:

1. list endpoints with the caller's Databricks client;
2. normalize live identities and capabilities;
3. join public catalog metadata by endpoint, model-service, provider, or alias
   identity;
4. retain unmatched live endpoints.

The matched `CatalogModelRecord` is attached to the live
`ServingEndpointSummary.catalog` field. Unpublished custom endpoints keep that
field unset.

## Runtime and language boundaries

The default Node client is a JSON client and does not require Python, Pyfig,
Pynect, or uv. The package includes a separate optional `/pynect` adapter for
the demo server. Catalog tests verify that Node and Python return identical
filtered content for the shared contract.

`@dbx-tools/model` uses the synchronous bundled snapshot at startup and the
default Node client for explicit public refreshes. It does not import the
Pynect adapter.

## Release

The integration depends on `@dbx-tools/dbx-model-catalog@^0.1.9`. The catalog
release includes schema v16, 94 records, the bundled search index, Node/Python
filter parity coverage, the optional Pynect demo integration, and a
bundler-safe inlined snapshot for PythonMonkey and other single-file consumers.

The following `@dbx-tools/model` behavior remains owned locally:

- live endpoint discovery, cache isolation, and refresh-on-miss behavior;
- unknown endpoint handling;
- exact endpoint and `system.ai.*` routing;
- model class ceilings and fallback policy;
- reasoning request and error adaptation;
- token-price estimation.

The removed metadata facade, local contract exports, and generated parser task
are intentional breaking changes.

## Validation

- TypeScript compilation for `packages/js/node/model`.
- The complete `packages/js/node/model/test` suite.
- Two consecutive Projen synthesis runs.
- Root lockfile policy and structural review before release.
