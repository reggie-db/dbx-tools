import { SearchBox, SearchResults, useSearch } from "@dbx-tools/ui-search/react";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@dbx-tools/ui-appkit/react";
import { useState } from "react";
import type { SearchHit } from "@dbx-tools/ui-search/react";

// AI Search demo over the server's `search()` plugin (@dbx-tools/search).
//
// - "Instant" is the drop-in `SearchBox`: search-as-you-type against the app's
//   default index, with a results dropdown. This is the autocomplete surface.
// - "Universal" fans the query across every configured index and merges hits.
// - "Results" uses the `useSearch` hook directly to drive a full-page
//   `SearchResults` list, showing how to compose the primitives yourself.
//
// All three read the plugin's boot config via `usePluginClientConfig("search")`
// (indexes, default, page size), so nothing here is hard-coded to a workspace.

const Selected = ({ hit }: { hit: SearchHit | null }) =>
  hit ? (
    <pre className="mt-4 max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
      {JSON.stringify(hit, null, 2)}
    </pre>
  ) : null;

const ResultsTab = () => {
  const { query, setQuery, hits, loading, error, config } = useSearch({ limit: 20 });
  return (
    <div className="flex flex-col gap-3">
      <input
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        placeholder="Search the index…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {config?.defaultIndex ? <Badge variant="secondary">{config.defaultIndex}</Badge> : null}
        {loading ? <span>Searching…</span> : <span>{hits.length} results</span>}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>
      <SearchResults hits={hits} showIndex />
    </div>
  );
};

const Search = () => {
  const [selected, setSelected] = useState<SearchHit | null>(null);
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-auto p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold">AI Search</h1>
        <p className="text-sm text-muted-foreground">
          Search Databricks AI Search (Vector Search) through the <code>@dbx-tools/search</code>{" "}
          plugin. Hybrid semantic + keyword matching.
        </p>
      </div>
      <Tabs defaultValue="instant" className="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="instant">Instant</TabsTrigger>
          <TabsTrigger value="universal">Universal</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
        </TabsList>
        <TabsContent value="instant">
          <SearchBox placeholder="Search the index…" onSelect={setSelected} />
          <Selected hit={selected} />
        </TabsContent>
        <TabsContent value="universal">
          <SearchBox universal showIndex placeholder="Search every index…" onSelect={setSelected} />
          <Selected hit={selected} />
        </TabsContent>
        <TabsContent value="results">
          <ResultsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Search;
