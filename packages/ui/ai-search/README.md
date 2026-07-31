# @dbx-tools/ui-ai-search

React search box and results for Databricks AI Search.

Import this package when an AppKit UI wants a drop-in, search-as-you-type box
over the [`@dbx-tools/ai-search`](../../node/ai-search) plugin. The components
read the plugin's boot config (indexes, default index, page size, route path)
through AppKit's `usePluginClientConfig`, so search is one component and zero
props.

**Key features:**

- `SearchBox` - a debounced, cancellable search-as-you-type input with a results
  dropdown, styled with AppKit tokens. Meilisearch-style instant search.
- `SearchResults` - a presentational hit list for a full-page results layout.
- `useSearch` - the hook the components share: `{ query, setQuery, hits,
loading, error, config, submit, clear }`, debounced and abortable, targeting
  the single-index or universal (federated) route.
- Universal search with one flag (`universal`) to search every configured index.
- `renderHit` overrides on both components for full control of a row; a sensible
  default shows a title, id, and score.

## Quick Start

```tsx
import { SearchBox } from "@dbx-tools/ui-ai-search/react";
import "@dbx-tools/ui-ai-search/styles.css";

export function DocsSearch() {
  return <SearchBox placeholder="Search docs…" onSelect={(hit) => open(hit.id)} />;
}
```

Universal search across every index the plugin knows about:

```tsx
<SearchBox universal showIndex placeholder="Search everything…" />
```

## Use The Hook

```tsx
import { useSearch, SearchResults } from "@dbx-tools/ui-ai-search/react";

function Results() {
  const { query, setQuery, hits, loading } = useSearch({ limit: 20 });
  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading ? "…" : <SearchResults hits={hits} />}
    </>
  );
}
```

## Subpaths

- `@dbx-tools/ui-ai-search/react` - `SearchBox`, `SearchResults`, `useSearch`,
  and the re-exported `SearchHit` / `SearchResult` / `SearchMode` /
  `SearchClientConfig` types.
- `@dbx-tools/ui-ai-search/styles.css` - AppKit-token styling for the box and
  results; import once after Tailwind and your AppKit-UI theme.

Runtime search, routes, and the plugin live in
[`@dbx-tools/ai-search`](../../node/ai-search); the wire contract lives in
[`@dbx-tools/shared-ai-search`](../../shared/ai-search).
