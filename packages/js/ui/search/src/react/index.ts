// React surface for `@dbx-tools/ui-search`: a drop-in `SearchBox`
// (search-as-you-type over Databricks AI Search), a `SearchResults` list for a
// full-page layout, and the `useSearch` hook they share. Single-index queries
// delegate to AppKit's native `useAiSearchQuery`; universal search uses the
// dbx-tools extension route.
// Styled with AppKit tokens (import `@dbx-tools/ui-search/styles.css`).

export type {
  SearchHit,
  SearchResult,
  SearchMode,
  SearchClientConfig,
} from "@dbx-tools/shared-search";
export { SearchBox, type SearchBoxProps } from "./search-box.tsx";
export { SearchResults, type SearchResultsProps } from "./search-results.tsx";
export { useSearch, type UseSearchOptions, type UseSearchState } from "./use-search.ts";
