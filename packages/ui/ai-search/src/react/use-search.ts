// `useSearch` — a small React hook that turns the AI Search plugin's HTTP
// routes into a debounced, cancellable search-as-you-type state machine. It
// reads the plugin's boot config (indexes, default index, page size, base path)
// via AppKit's `usePluginClientConfig`, so a search box needs no props to know
// where to POST. Point it at `@dbx-tools/ai-search`'s `POST /api/ai-search`
// (single index) or `POST /api/ai-search/universal` (federated) route.

import type {
  SearchClientConfig,
  SearchHit,
  SearchMode,
  SearchResult,
} from "@dbx-tools/shared-ai-search";
import { usePluginClientConfig } from "@dbx-tools/ui-appkit/react";
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
  /** The plugin name to read config from / route under. Defaults to "aiSearch". */
  pluginName?: string;
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

const DEFAULT_BASE_PATH = "/api/ai-search";

/**
 * Search-as-you-type against the AI Search plugin. Debounces input, cancels the
 * previous request when a new one starts, and exposes `{ query, setQuery, hits,
 * loading, error }` for a search box to render. Reads the plugin's client config
 * for the base path, default index, and page size.
 */
export function useSearch(options: UseSearchOptions = {}): UseSearchState {
  const pluginName = options.pluginName ?? "aiSearch";
  const config = usePluginClientConfig<SearchClientConfig>(pluginName);
  const basePath = config?.basePath ?? DEFAULT_BASE_PATH;
  const debounceMs = options.debounceMs ?? 200;
  const minLength = options.minLength ?? 1;

  const [query, setQueryState] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (text: string) => {
      abortRef.current?.abort();
      if (text.trim().length < minLength) {
        setHits([]);
        setLoading(false);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const path = options.universal ? `${basePath}/universal` : basePath;
        const body = options.universal
          ? {
              query: text,
              ...(options.limit ? { limit: options.limit } : {}),
              ...(options.mode ? { mode: options.mode } : {}),
            }
          : {
              query: text,
              ...(options.index ? { index: options.index } : {}),
              ...(options.limit ? { limit: options.limit } : {}),
              ...(options.mode ? { mode: options.mode } : {}),
            };
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`search failed (${response.status})`);
        }
        const result = (await response.json()) as SearchResult;
        setHits(result.hits ?? []);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
        setHits([]);
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    },
    [basePath, minLength, options.index, options.limit, options.mode, options.universal],
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
    setError(null);
    setLoading(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  return useMemo(
    () => ({ query, setQuery, hits, loading, error, config, submit, clear }),
    [query, setQuery, hits, loading, error, config, submit, clear],
  );
}
