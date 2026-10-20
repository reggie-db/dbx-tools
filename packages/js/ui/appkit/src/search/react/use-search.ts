// `useSearch` adapts AppKit's native `useAiSearchQuery` to a debounced
// search-as-you-type state machine. Single-index queries use AppKit's native
// route and client config; universal queries use the dbx-tools extension route.

import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import { useAiSearchQuery, type AiSearchRequest } from "@databricks/appkit-ui/react/beta";
import {
  SEARCH_DEFAULT_BASE_PATH,
  SEARCH_PLUGIN_NAME,
  SEARCH_ROUTES,
  type SearchClientConfig,
  type SearchHit,
  type SearchMode,
  type SearchResult,
  searchResultSchema,
  searchClientConfigSchema,
  searchRoute,
  toAiSearchQueryType,
} from "@dbx-tools/shared-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Options for {@link useSearch}. */
export interface UseSearchOptions {
  /** Which index to search (name or alias). Defaults to the plugin's default index. */
  index?: string;
  /** Search every configured index and merge results (universal search). */
  universal?: boolean;
  /** Match mode. Defaults to the plugin's configured mode. */
  mode?: SearchMode;
  /** Max hits to request. Defaults to the plugin's configured page size. */
  limit?: number;
  /** Debounce in ms before a keystroke triggers a request. Defaults to 200. */
  debounceMs?: number;
  /** Minimum query length before searching. Defaults to 1. */
  minLength?: number;
}

/** The state {@link useSearch} returns. */
export interface UseSearchState {
  /** The current query text. */
  query: string;
  /** Set the query (triggers a debounced search). */
  setQuery: (query: string) => void;
  /** The latest hits, most relevant first. */
  hits: SearchHit[];
  /** True while a request is in flight. */
  loading: boolean;
  /** The last error, if any. */
  error: string | null;
  /** The resolved plugin config (indexes, default, page size). */
  config: SearchClientConfig | undefined;
  /** Run the search immediately (bypassing the debounce). */
  submit: () => void;
  /** Clear the query and hits. */
  clear: () => void;
}

/** Validate one universal-search response with the owning shared schema. */
export function parseUniversalSearchResult(value: unknown): SearchResult {
  return searchResultSchema.parse(value);
}

/** Validate the published extension config, treating AppKit's empty sentinel as absent. */
export function parseSearchClientConfig(value: unknown): SearchClientConfig | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    return undefined;
  }
  return searchClientConfigSchema.parse(value);
}

/** A single configured index is already the complete universal-search set. */
export function usesUniversalSearchRoute(
  universal: boolean | undefined,
  indexCount: number,
): boolean {
  return universal === true && indexCount !== 1;
}

function toHits(
  results: Array<{ score: number; data: Record<string, unknown> }>,
  index: string | null,
): SearchHit[] {
  return results.map((result, resultIndex) => ({
    id: String(result.data.id ?? Object.values(result.data)[0] ?? resultIndex),
    score: result.score,
    fields: result.data,
    ...(index ? { index } : {}),
  }));
}

/**
 * Search-as-you-type against AppKit AI Search. Debounces input, cancels stale
 * native queries, and exposes `{ query, setQuery, hits, loading, error }` for a
 * search box to render.
 */
export function useSearch(options: UseSearchOptions = {}): UseSearchState {
  const native = useAiSearchQuery({ ...(options.index ? { alias: options.index } : {}) });
  const publishedConfig = usePluginClientConfig<unknown>(SEARCH_PLUGIN_NAME);
  const config = useMemo(() => parseSearchClientConfig(publishedConfig), [publishedConfig]);
  const debounceMs = options.debounceMs ?? 200;
  const minLength = options.minLength ?? 1;
  const useUniversalRoute = usesUniversalSearchRoute(
    options.universal,
    config?.indexes.length ?? native.indexes.length,
  );
  const universalSearchPath = searchRoute(
    config?.basePath ?? SEARCH_DEFAULT_BASE_PATH,
    SEARCH_ROUTES.universal,
  );

  const [query, setQueryState] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [universalLoading, setUniversalLoading] = useState(false);
  const [universalError, setUniversalError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      if (text.trim().length < minLength) {
        setHits([]);
        setUniversalLoading(false);
        return;
      }
      if (!useUniversalRoute) {
        const resolvedQueryType = toAiSearchQueryType(options.mode);
        const request: AiSearchRequest = {
          queryText: text,
          ...(options.limit ? { numResults: options.limit } : {}),
          ...(resolvedQueryType ? { queryType: resolvedQueryType } : {}),
        };
        const result = await native.search(request);
        setHits(result ? toHits(result.results, native.alias) : []);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setUniversalLoading(true);
      setUniversalError(null);
      try {
        const response = await fetch(universalSearchPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: text,
            ...(options.limit ? { limit: options.limit } : {}),
            ...(options.mode ? { mode: options.mode } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`search failed (${response.status})`);
        }
        const result = parseUniversalSearchResult(await response.json());
        setHits(result.hits);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setUniversalError((err as Error).message);
        setHits([]);
      } finally {
        if (abortRef.current === controller) setUniversalLoading(false);
      }
    },
    [
      minLength,
      native.alias,
      native.search,
      options.limit,
      options.mode,
      universalSearchPath,
      useUniversalRoute,
    ],
  );

  const setQuery = useCallback(
    (text: string) => {
      setQueryState(text);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void run(text), debounceMs);
    },
    [debounceMs, run],
  );

  const submit = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void run(query);
  }, [query, run]);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    setQueryState("");
    setHits([]);
    setUniversalError(null);
    setUniversalLoading(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const loading = useUniversalRoute ? universalLoading : native.loading;
  const error = useUniversalRoute ? universalError : native.error;
  return useMemo(
    () => ({ query, setQuery, hits, loading, error, config, submit, clear }),
    [query, setQuery, hits, loading, error, config, submit, clear],
  );
}
