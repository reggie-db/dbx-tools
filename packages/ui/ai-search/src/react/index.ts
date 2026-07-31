// React surface for `@dbx-tools/ui-ai-search`: a drop-in `SearchBox`
// (search-as-you-type over Databricks AI Search), a `SearchResults` list for a
// full-page layout, and the `useSearch` hook they share. All three talk to the
// `@dbx-tools/ai-search` plugin's routes and read its boot config through
// AppKit's `usePluginClientConfig`, so search is one component and zero props.
// Styled with AppKit tokens (import `@dbx-tools/ui-ai-search/styles.css`).

export type {
  SearchHit,
  SearchResult,
  SearchMode,
  SearchClientConfig,
} from "@dbx-tools/shared-ai-search";
export { SearchBox, type SearchBoxProps } from "./search-box.tsx";
export { SearchResults, type SearchResultsProps } from "./search-results.tsx";
export { useSearch, type UseSearchOptions, type UseSearchState } from "./use-search.ts";
