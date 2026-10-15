/**
 * Brand research composed from the web-search plugin's search and fetch
 * operations.
 *
 * @module
 */

import type {
  WebFetchRequest,
  WebFetchResult,
  WebSearchCitation,
  WebSearchRequest,
  WebSearchResult,
} from "@dbx-tools/appkit-web-search/schema";
import { errorUtils, log, stringUtils } from "@dbx-tools/shared-core";
import type {
  BrandGenerationProgressEvent,
  BrandGenerationRequest,
  BrandPackageSource,
} from "./schema.ts";

const logger = log.logger("brand/research");

/** Default number of cited pages fetched for one brand. */
export const DEFAULT_MAX_SOURCES = 4;

/** Default character cap for each fetched page excerpt. */
export const DEFAULT_SOURCE_MAX_LENGTH = 8_000;

/** Upper bound that prevents one request from fanning out across too many sites. */
export const MAX_SOURCES = 8;

/** Upper bound on readable characters retained from one fetched page. */
export const MAX_SOURCE_MAX_LENGTH = 20_000;

/** Markup cap used for official-page asset discovery. */
export const ASSET_HTML_MAX_LENGTH = 50_000;

/** Search and fetch operations supplied by the registered web-search plugin. */
export interface BrandResearchClient {
  /** Search the web and return a synthesized answer with citations. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
  /** Fetch one cited page as text or HTML. */
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}

/** Research options controlling bounded page reads. */
export interface BrandResearchOptions {
  /** Maximum number of unique sources to fetch. */
  maxSources?: number;
  /** Maximum text characters retained from each source. */
  sourceMaxLength?: number;
  /** Receives observable workflow progress. */
  onProgress?: BrandProgressReporter;
}

/** Callback receiving one validated workflow progress event. */
export type BrandProgressReporter = (event: BrandGenerationProgressEvent) => void | Promise<void>;

/** One selected source and the text made available to synthesis. */
export interface BrandResearchSource extends BrandPackageSource {
  /** Readable page text, omitted when the fetch failed. */
  content?: string;
}

/** Search answer, fetched sources, and official-page markup used by generation. */
export interface BrandResearch {
  /** Web-search model's evidence summary. */
  answer: string;
  /** Endpoint or fallback that ran the web search. */
  model: string;
  /** Selected and deduplicated citations. */
  sources: BrandResearchSource[];
  /** URL of the first source selected as the likely official page. */
  officialPageUrl: string;
  /** Raw markup used only for deterministic asset discovery. */
  officialPageHtml?: string;
}

/** Build the focused, first-party search request for a brand. */
export function brandResearchQuery(request: BrandGenerationRequest): string {
  const website = request.website ? ` The known official website is ${request.website}.` : "";
  return stringUtils.toDescription(`
    Research the official brand identity for "${request.name}".${website}
    Prefer first-party sources and cite the official website first. Identify
    the canonical and short names, current tagline, plain-language
    description, audiences, writing tone, brand colors as hex values,
    typography, documentation, source repository, logo, icon, and favicon.
    Distinguish documented facts from reasonable visual inferences.
  `);
}

/** Return a normalized public HTTPS URL or `undefined`. */
function publicHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Compute a small first-party likelihood score while preserving search order. */
function sourceScore(
  citation: WebSearchCitation,
  request: BrandGenerationRequest,
  index: number,
): number {
  const url = new URL(citation.url);
  const knownWebsite = request.website ? new URL(request.website) : undefined;
  const normalizedName = request.name.toLowerCase().replace(/[^a-z\d]/g, "");
  const normalizedHost = url.hostname.toLowerCase().replace(/[^a-z\d]/g, "");
  const sameKnownOrigin = knownWebsite?.origin === url.origin ? 1_000 : 0;
  const hostMatchesName =
    normalizedName.length >= 3 &&
    (normalizedHost.includes(normalizedName) || normalizedName.includes(normalizedHost))
      ? 100
      : 0;
  const titleMatchesName = citation.title?.toLowerCase().includes(request.name.toLowerCase())
    ? 10
    : 0;
  return sameKnownOrigin + hostMatchesName + titleMatchesName - index;
}

/** Select unique HTTPS citations and put the likely official page first. */
function selectSources(
  citations: readonly WebSearchCitation[],
  request: BrandGenerationRequest,
  maxSources: number,
): WebSearchCitation[] {
  const candidates = request.website
    ? [{ url: request.website, title: `${request.name} official website` }, ...citations]
    : [...citations];
  const unique = new Map<string, WebSearchCitation>();
  for (const citation of candidates) {
    const url = publicHttpsUrl(citation.url);
    if (url && !unique.has(url)) unique.set(url, { ...citation, url });
  }
  return [...unique.values()]
    .map((citation, index) => ({ citation, score: sourceScore(citation, request, index) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxSources)
    .map(({ citation }) => citation);
}

/** Fetch one citation as readable text without failing the whole research pass. */
async function fetchSource(
  client: BrandResearchClient,
  citation: WebSearchCitation,
  sourceMaxLength: number,
  onComplete: () => void | Promise<void>,
  signal?: AbortSignal,
): Promise<BrandResearchSource> {
  try {
    const page = await client.fetch(
      { url: citation.url, format: "text", maxLength: sourceMaxLength },
      signal,
    );
    return {
      ...citation,
      url: page.url,
      ...(page.title ? { title: page.title } : {}),
      fetched: true,
      content: page.content,
    };
  } catch (error) {
    logger.warn("source-fetch-failed", {
      url: citation.url,
      error: errorUtils.toError(error),
    });
    return { ...citation, fetched: false };
  } finally {
    await onComplete();
  }
}

/**
 * Search for a brand, fetch a bounded set of cited pages, and retain the first
 * page's markup for logo and favicon discovery.
 */
export async function researchBrand(
  request: BrandGenerationRequest,
  client: BrandResearchClient,
  options: BrandResearchOptions = {},
  signal?: AbortSignal,
): Promise<BrandResearch> {
  const maxSources = Math.min(Math.max(1, options.maxSources ?? DEFAULT_MAX_SOURCES), MAX_SOURCES);
  const sourceMaxLength = Math.max(
    1,
    Math.min(options.sourceMaxLength ?? DEFAULT_SOURCE_MAX_LENGTH, MAX_SOURCE_MAX_LENGTH),
  );
  await options.onProgress?.({
    type: "progress",
    stage: "search",
    message: `Searching for official ${request.name} brand sources`,
  });
  const search = await client.search({ query: brandResearchQuery(request) }, signal);
  const citations = selectSources(search.citations, request, maxSources);
  if (citations.length === 0) {
    throw new Error(
      `Brand research for "${request.name}" returned no public HTTPS sources to fetch.`,
    );
  }
  let completedSources = 0;
  await options.onProgress?.({
    type: "progress",
    stage: "fetch",
    message: `Reading 0 of ${citations.length} sources`,
    current: 0,
    total: citations.length,
  });

  const official = citations[0];
  const [sources, officialHtml] = await Promise.all([
    Promise.all(
      citations.map((citation) =>
        fetchSource(
          client,
          citation,
          sourceMaxLength,
          async () => {
            completedSources += 1;
            await options.onProgress?.({
              type: "progress",
              stage: "fetch",
              message: `Read ${completedSources} of ${citations.length} sources`,
              current: completedSources,
              total: citations.length,
            });
          },
          signal,
        ),
      ),
    ),
    client
      .fetch(
        {
          url: official.url,
          format: "html",
          maxLength: ASSET_HTML_MAX_LENGTH,
        },
        signal,
      )
      .catch((error: unknown) => {
        logger.warn("official-page-html-fetch-failed", {
          url: official.url,
          error: errorUtils.toError(error),
        });
        return undefined;
      }),
  ]);
  await options.onProgress?.({
    type: "progress",
    stage: "assets",
    message: officialHtml
      ? "Found official page artwork"
      : "Using the official site favicon fallback",
  });

  return {
    answer: search.answer,
    model: search.model,
    sources,
    officialPageUrl: officialHtml?.url ?? official.url,
    ...(officialHtml ? { officialPageHtml: officialHtml.content } : {}),
  };
}
