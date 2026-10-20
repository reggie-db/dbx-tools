import {
  Badge,
  Button,
  Input,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@databricks/appkit-ui/react";
import type { SearchHit } from "@dbx-tools/shared-search";
import { useSearch } from "@dbx-tools/ui/search/react";
import { ArrowUpRightIcon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

const AUTO_QUERIES = ["app", "agent", "Lakebox", "search"];
const SUGGESTIONS = ["direct Genie", "platformer game", "message bus", "email branding"];

function textField(hit: SearchHit, key: string): string | undefined {
  const value = hit.fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const SearchCard = ({ hit, showIndex }: { hit: SearchHit; showIndex: boolean }) => {
  const title = textField(hit, "title") ?? hit.id;
  const summary = textField(hit, "text") ?? "Open this result to read the source documentation.";
  const url = textField(hit, "url");
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {showIndex && hit.index ? <Badge variant="secondary">{hit.index}</Badge> : null}
            <span className="text-xs font-medium text-muted-foreground">
              Relevance {hit.score.toFixed(2)}
            </span>
          </div>
          <h3 className="text-base font-semibold leading-snug text-foreground">{title}</h3>
        </div>
        {url ? <ArrowUpRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" /> : null}
      </div>
      <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{summary}</p>
    </>
  );

  return (
    <li className="min-w-0">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex h-full min-h-44 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </a>
      ) : (
        <div className="flex h-full min-h-44 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          {content}
        </div>
      )}
    </li>
  );
};

const SearchExperience = ({ universal = false }: { universal?: boolean }) => {
  const { query, setQuery, hits, loading, error, config, clear } = useSearch({
    universal,
    limit: 12,
    debounceMs: 120,
    minLength: 2,
  });
  const [autoTyping, setAutoTyping] = useState(true);

  useEffect(() => {
    if (!autoTyping) return;
    let phraseIndex = 0;
    let characterIndex = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const typeNext = () => {
      const phrase = AUTO_QUERIES[phraseIndex]!;
      if (characterIndex <= phrase.length) {
        setQuery(phrase.slice(0, characterIndex));
        characterIndex += 1;
        timer = setTimeout(typeNext, 70);
        return;
      }
      phraseIndex = (phraseIndex + 1) % AUTO_QUERIES.length;
      characterIndex = 0;
      timer = setTimeout(typeNext, 2600);
    };
    timer = setTimeout(typeNext, 250);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [autoTyping, setQuery]);

  const takeControl = () => setAutoTyping(false);
  const chooseQuery = (value: string) => {
    takeControl();
    setQuery(value);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            aria-label={universal ? "Search every configured index" : "Search the default index"}
            placeholder={
              universal ? "Search every configured index" : "Search Databricks app capabilities"
            }
            className="h-11 pl-9 pr-10 text-base"
            onFocus={takeControl}
            onChange={(event) => chooseQuery(event.target.value)}
          />
          {query ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-1.5 top-1/2 size-8 -translate-y-1/2"
              aria-label="Clear search"
              onClick={() => {
                takeControl();
                clear();
              }}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Try</span>
          {SUGGESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => chooseQuery(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      </div>

      <div
        className="flex min-h-6 flex-wrap items-center gap-2 text-xs text-muted-foreground"
        aria-live="polite"
      >
        {config?.defaultIndex ? <Badge variant="secondary">{config.defaultIndex}</Badge> : null}
        {universal ? <Badge variant="outline">All configured indexes</Badge> : null}
        {loading ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="size-3" /> Searching
          </span>
        ) : (
          <span>{query.trim().length >= 2 ? `${hits.length} results` : "Type to search"}</span>
        )}
        {autoTyping ? (
          <span className="inline-flex items-center gap-1">
            <SparklesIcon className="size-3" /> Demo typing stops when you focus the field
          </span>
        ) : null}
        {error ? <span className="text-destructive">{error}</span> : null}
      </div>

      {hits.length > 0 ? (
        <ul className="grid gap-3 pb-4 md:grid-cols-2">
          {hits.map((hit) => (
            <SearchCard key={`${hit.index ?? ""}:${hit.id}`} hit={hit} showIndex={universal} />
          ))}
        </ul>
      ) : (
        <div className="flex min-h-64 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
          <div className="max-w-sm space-y-2">
            <SearchIcon className="mx-auto size-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {loading ? "Searching the demo corpus" : "No matching documentation yet"}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              Try a capability such as Genie, Lakebox, approvals, message bus, search, or email.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

const Search = () => (
  <div className="h-full overflow-y-auto bg-background">
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 px-4 py-5 md:px-6 md:py-7">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">AI Search</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Search a seeded set of Databricks app patterns with the same governed contract used by
          React screens and Mastra agents.
        </p>
      </div>
      <Tabs defaultValue="ai-search" className="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList className="self-start">
          <TabsTrigger value="ai-search">AI Search</TabsTrigger>
          <TabsTrigger value="universal">Universal search</TabsTrigger>
        </TabsList>
        <TabsContent value="ai-search" className="mt-0 flex min-h-0 flex-1 flex-col">
          <SearchExperience />
        </TabsContent>
        <TabsContent value="universal" className="mt-0 flex min-h-0 flex-1 flex-col">
          <SearchExperience universal />
        </TabsContent>
      </Tabs>
    </div>
  </div>
);

export default Search;
