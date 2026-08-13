# @dbx-tools/ui-search

React search box and results for Databricks AI Search.

Import this package when an AppKit UI wants a drop-in, search-as-you-type box
over AppKit's beta `aiSearch` plugin. The components delegate single-index
queries to `useAiSearchQuery`, so native AppKit owns aliases, routes,
cancellation, and query state. The same UI works with
`@dbx-tools/search`'s `lakebaseAiSearch` provider because it implements the
native client-config and response contract.

**Key features:**

- `SearchBox` - a debounced, cancellable search-as-you-type input with a results
  dropdown, styled with AppKit tokens. Meilisearch-style instant search.
- `SearchResults` - a presentational hit list for a full-page results layout.
- `useSearch` - a debounced presentation adapter over AppKit
  `useAiSearchQuery`: `{ query, setQuery, hits,
loading, error, config, submit, clear }`, debounced and abortable, targeting
  native single-index queries or the dbx-tools universal route.
- Universal search with one flag (`universal`) to search every configured index.
- `renderHit` overrides on both components for full control of a row; a sensible
  default shows a title, id, and score.

## Quick Start

```tsx
import { SearchBox } from "@dbx-tools/ui-search/react";
import "@dbx-tools/ui-search/styles.css";

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
import { useSearch, SearchResults } from "@dbx-tools/ui-search/react";

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

- `@dbx-tools/ui-search/react` - `SearchBox`, `SearchResults`, `useSearch`,
  and the re-exported `SearchHit` / `SearchResult` / `SearchMode` /
  `SearchClientConfig` types.
- `@dbx-tools/ui-search/styles.css` - AppKit-token styling for the box and
  results; import once after Tailwind and your AppKit-UI theme.

Native Vector Search runtime and routes come from `@databricks/appkit`.
Federated search, agent tools, lifecycle operations, and the Lakebase provider
live in [`@dbx-tools/search`](../../node/search); its extension wire contract
lives in [`@dbx-tools/shared-search`](../../shared/search).
