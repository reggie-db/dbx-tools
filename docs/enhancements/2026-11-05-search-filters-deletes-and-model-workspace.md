# Search filters, document deletes, and a separate model workspace

Status: **active.** Copied from Lakespan (`reggie-db/lakespan`, branch
`dev-simplify`), where each gap forced a local workaround.

## 1. Browser search filters (done on this branch)

`useSearch` in `packages/js/ui/appkit/src/search/react/use-search.ts` had no
way to pass attribute filters, although AppKit's `AiSearchRequest` accepts
`filters` and the Lakebase provider compiles them to SQL. An app that indexes
one entity per run, tenant, or workspace had to fetch a broad top N and filter
in the browser, which drops real matches. Lakespan wrote its own debounced
search hook against a custom route to work around it.

This branch adds `filters` to `UseSearchOptions` for single-index queries and a
tested `nativeSearchRequest` helper. The universal route still has no filter
contract. Adding one to `universalSearchRequestSchema` in
`@dbx-tools/shared-search` is the follow-up.

## 2. Lakebase document deletes (done on this branch)

`LakebaseSearchBackend.deleteDocuments` existed, but `LakebaseAiSearchPlugin`
exported only `query` and `addDocuments`. An app that rebuilds an index could
not remove documents for entities that no longer exist. Lakespan deleted rows
with direct SQL against the provider's table.

This branch exports an in-process `deleteDocuments(alias, ids)` gated by
`allowWrite`, the same as `addDocuments`. No HTTP route is mounted for it.

## 3. Separate model workspace (proposed)

`resolveModelWorkspaceClient` in `appkit-mastra` always uses the request's
workspace, through the user or service-principal client. There is no way to
read evidence from one workspace and run inference on another workspace's
serving endpoints. Lakespan added an opt-in `LLM_DATABRICKS_PROFILE` for its
own structured completions, but the agent runtime cannot follow it.

Proposal: a `models.profile` (or `models.host` plus auth) option on the Mastra
plugin, used by model discovery and inference only. Default off. Document that
prompts, including any evidence in them, are sent to that workspace.

## 4. In-process writes without the HTTP write surface (proposed)

`allowWrite` on both the search extension and the Lakebase plugin enables
in-process writes and also mounts HTTP document routes. An app that only
writes from the server has to expose those routes to get in-process writes.
Split the flag into `allowWrite` (in-process) and `exposeWriteRoutes` (HTTP).
