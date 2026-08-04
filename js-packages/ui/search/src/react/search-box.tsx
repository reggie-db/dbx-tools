// `SearchBox` — a drop-in, Meilisearch-style search-as-you-type input for
// Databricks AI Search. It wires an AppKit `Input` to the {@link useSearch}
// hook and renders the hits in a dropdown as the user types, so adding search
// to an app is one component and zero configuration: the plugin's client config
// supplies the index, page size, and route.
//
// It is presentational and unopinionated about what a hit looks like: pass a
// `renderHit` to control each row, or rely on the default which shows the first
// string-ish field as a title and the primary-key `id` as a subtitle. Styled
// with AppKit tokens (see `../styles.css`).

import type { SearchHit } from "@dbx-tools/shared-search";
import { Badge, Button, Input, ScrollArea, Spinner, cn } from "@dbx-tools/ui-appkit/react";
import { SearchIcon, XIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { useSearch, type UseSearchOptions } from "./use-search.ts";

/** Props for {@link SearchBox}. */
export interface SearchBoxProps extends UseSearchOptions {
  /** Placeholder text for the input. */
  placeholder?: string;
  /** Called when the user picks a hit (click or Enter on a focused row). */
  onSelect?: (hit: SearchHit) => void;
  /** Render one hit row. Defaults to a title + id + score badge. */
  renderHit?: (hit: SearchHit) => ReactNode;
  /** Show the source index name on each hit (useful for universal search). */
  showIndex?: boolean;
  /** Extra class names for the outer container. */
  className?: string;
}

/** Pick the most title-like string field from a hit for the default row. */
function hitTitle(hit: SearchHit): string {
  for (const key of ["title", "name", "text", "content", "body"]) {
    const value = hit.fields[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const firstString = Object.values(hit.fields).find(
    (value) => typeof value === "string" && value.trim(),
  );
  return typeof firstString === "string" ? firstString : hit.id;
}

/**
 * A search-as-you-type box over AI Search. Renders an input and a results
 * dropdown, debouncing keystrokes and cancelling stale requests through
 * {@link useSearch}.
 *
 * @example
 * ```tsx
 * import { SearchBox } from "@dbx-tools/ui-search/react";
 * import "@dbx-tools/ui-search/styles.css";
 *
 * <SearchBox placeholder="Search docs…" onSelect={(hit) => open(hit.id)} />
 * ```
 */
export function SearchBox({
  placeholder = "Search…",
  onSelect,
  renderHit,
  showIndex,
  className,
  ...searchOptions
}: SearchBoxProps): ReactNode {
  const { query, setQuery, hits, loading, error, clear, submit } = useSearch(searchOptions);
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback(
    (hit: SearchHit) => {
      onSelect?.(hit);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <div className={cn("dbx-search-box", className)}>
      <div className="dbx-search-box__field">
        <SearchIcon className="dbx-search-box__icon" aria-hidden />
        <Input
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {loading ? <Spinner className="dbx-search-box__spinner" /> : null}
        {query ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            onClick={() => {
              clear();
              setOpen(false);
            }}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>

      {open && (query.trim() || error) ? (
        <div className="dbx-search-box__panel" role="listbox">
          {error ? <div className="dbx-search-box__error">{error}</div> : null}
          {!error && hits.length === 0 && !loading ? (
            <div className="dbx-search-box__empty">No results</div>
          ) : null}
          <ScrollArea className="dbx-search-box__results">
            {hits.map((hit) => (
              <button
                key={`${hit.index ?? ""}:${hit.id}`}
                type="button"
                role="option"
                aria-selected={false}
                className="dbx-search-box__hit"
                onClick={() => handleSelect(hit)}
              >
                {renderHit ? (
                  renderHit(hit)
                ) : (
                  <div className="dbx-search-box__hit-default">
                    <span className="dbx-search-box__hit-title">{hitTitle(hit)}</span>
                    <span className="dbx-search-box__hit-meta">
                      {showIndex && hit.index ? (
                        <Badge variant="secondary">{hit.index}</Badge>
                      ) : null}
                      <span className="dbx-search-box__hit-id">{hit.id}</span>
                    </span>
                  </div>
                )}
              </button>
            ))}
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}
