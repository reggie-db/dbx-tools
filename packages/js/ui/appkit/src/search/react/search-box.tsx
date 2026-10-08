// `SearchBox` is a drop-in search-as-you-type input for
// Databricks AI Search. It wires an AppKit `Input` to the {@link useSearch}
// hook and renders hits in a dropdown as the user types. AppKit's native
// `aiSearch` client config supplies the index alias and query route.
//
// It is presentational and unopinionated about what a hit looks like: pass a
// `renderHit` to control each row, or rely on the default which shows the first
// string-ish field as a title and the primary-key `id` as a subtitle. Styled
// with AppKit tokens (see `../styles.css`).

import type { SearchHit } from "@dbx-tools/shared-search";
import { XIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { useSearch, type UseSearchOptions } from "./use-search.ts";
import {
  Badge,
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Spinner,
  cn,
} from "../../react/index.ts";

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
 * import { SearchBox } from "@dbx-tools/ui/search/react";
 * import "@dbx-tools/ui/search/styles.css";
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
    <Command
      shouldFilter={false}
      className={cn("dbx-search-box h-auto overflow-visible bg-transparent", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <div className="dbx-search-box__field">
        <CommandInput
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onValueChange={(value) => {
            setQuery(value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && hits.length === 0) submit();
          }}
        />
        {loading ? <Spinner className="dbx-search-box__spinner" /> : null}
        {query ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            className="dbx-search-box__clear"
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
        <CommandList className="dbx-search-box__panel dbx-search-box__results">
          {error ? <div className="dbx-search-box__error">{error}</div> : null}
          {!error && !loading ? <CommandEmpty>No results</CommandEmpty> : null}
          {hits.map((hit) => (
            <CommandItem
              key={`${hit.index ?? ""}:${hit.id}`}
              value={JSON.stringify([hit.index ?? "", hit.id])}
              className="dbx-search-box__hit"
              onSelect={() => handleSelect(hit)}
            >
              {renderHit ? (
                renderHit(hit)
              ) : (
                <div className="dbx-search-box__hit-default">
                  <span className="dbx-search-box__hit-title">{hitTitle(hit)}</span>
                  <span className="dbx-search-box__hit-meta">
                    {showIndex && hit.index ? <Badge variant="secondary">{hit.index}</Badge> : null}
                    <span className="dbx-search-box__hit-id">{hit.id}</span>
                  </span>
                </div>
              )}
            </CommandItem>
          ))}
        </CommandList>
      ) : null}
    </Command>
  );
}
