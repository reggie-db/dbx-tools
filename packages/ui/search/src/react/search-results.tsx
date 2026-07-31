// `SearchResults` — a presentational list of AI Search hits for a full-page
// results layout (as opposed to the `SearchBox` dropdown). Give it `hits` from
// `useSearch` (or any `SearchResult`) and it renders a scored, index-tagged
// list; pass `renderHit` to control a row. Styled with AppKit tokens.

import type { SearchHit } from "@dbx-tools/shared-search";
import { Badge, cn } from "@dbx-tools/ui-appkit/react";
import type { ReactNode } from "react";

/** Props for {@link SearchResults}. */
export interface SearchResultsProps {
  /** The hits to render, most relevant first. */
  hits: SearchHit[];
  /** Called when a hit is clicked. */
  onSelect?: (hit: SearchHit) => void;
  /** Render one hit row. Defaults to a title, fields, and a score badge. */
  renderHit?: (hit: SearchHit) => ReactNode;
  /** Show each hit's source index (useful for universal search). */
  showIndex?: boolean;
  /** Message shown when there are no hits. */
  emptyMessage?: ReactNode;
  /** Extra class names for the container. */
  className?: string;
}

function hitTitle(hit: SearchHit): string {
  for (const key of ["title", "name", "text", "content", "body"]) {
    const value = hit.fields[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return hit.id;
}

/** A full-page list of search hits. */
export function SearchResults({
  hits,
  onSelect,
  renderHit,
  showIndex,
  emptyMessage = "No results",
  className,
}: SearchResultsProps): ReactNode {
  if (hits.length === 0) {
    return <div className={cn("dbx-search-results__empty", className)}>{emptyMessage}</div>;
  }
  return (
    <ul className={cn("dbx-search-results", className)}>
      {hits.map((hit) => (
        <li key={`${hit.index ?? ""}:${hit.id}`} className="dbx-search-results__item">
          <button
            type="button"
            className="dbx-search-results__button"
            onClick={() => onSelect?.(hit)}
          >
            {renderHit ? (
              renderHit(hit)
            ) : (
              <>
                <div className="dbx-search-results__header">
                  <span className="dbx-search-results__title">{hitTitle(hit)}</span>
                  <Badge variant="outline">{hit.score.toFixed(3)}</Badge>
                </div>
                {showIndex && hit.index ? (
                  <Badge variant="secondary" className="dbx-search-results__index">
                    {hit.index}
                  </Badge>
                ) : null}
              </>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
