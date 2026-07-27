// A self-contained dev tool for the Teams add-on: pick or paste a `CardSpec`,
// send it to the server's `POST /api/teams/card` route to compile it into an
// Adaptive Card, and render the result with the `adaptivecards` renderer. This
// is the "have this display them" surface - drop `<AdaptiveCardGallery/>` on a
// page and you get a live card preview backed by the real server builder.

import { json } from "@dbx-tools/shared-core";
import { card, type CardResult, type CardSpec } from "@dbx-tools/shared-teams";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from "@dbx-tools/ui-appkit/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdaptiveCardView } from "./adaptive-card";
import { CARD_SAMPLES } from "./samples";

/** Props for {@link AdaptiveCardGallery}. */
export interface AdaptiveCardGalleryProps {
  /**
   * The server route that compiles a `CardSpec` into an Adaptive Card. Defaults
   * to the `@dbx-tools/teams` plugin's mount (`/api/teams/card`).
   */
  buildEndpoint?: string;
  /** Extra classes merged onto the root container. */
  className?: string;
}

/** Pretty-print a spec for the editable textarea. */
const format = (spec: CardSpec): string => JSON.stringify(spec, null, 2);

/**
 * Live Adaptive Card preview. Edits to the JSON are debounced and posted to the
 * server builder; the returned card is rendered with the `adaptivecards`
 * package. Falls back to a local build only for the initial paint so the panel
 * is never empty while the first request is in flight.
 */
export const AdaptiveCardGallery = ({
  buildEndpoint = "/api/teams/card",
  className,
}: AdaptiveCardGalleryProps) => {
  const [sampleIndex, setSampleIndex] = useState(0);
  const [source, setSource] = useState(() => format(CARD_SAMPLES[0]!.spec));
  const [result, setResult] = useState<CardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spec = useMemo(() => {
    const parsed = card.cardSpecSchema.safeParse(json.parse(source, undefined));
    return parsed.success ? parsed.data : null;
  }, [source]);

  const build = useCallback(
    async (draft: CardSpec, signal: AbortSignal) => {
      try {
        const response = await fetch(buildEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(draft),
          signal,
        });
        const payload = await response.json();
        if (!response.ok) {
          setError(payload?.error ?? `Build failed (${response.status})`);
          return;
        }
        const parsed = card.cardResultSchema.safeParse(payload);
        if (!parsed.success) {
          setError("Server returned an unexpected card shape.");
          return;
        }
        setResult(parsed.data);
        setError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      }
    },
    [buildEndpoint],
  );

  useEffect(() => {
    if (!spec) {
      setError("The card JSON is not a valid CardSpec.");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => void build(spec, controller.signal), 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [spec, build]);

  const chooseSample = (value: string) => {
    const index = Number(value);
    setSampleIndex(index);
    setSource(format(CARD_SAMPLES[index]!.spec));
  };

  return (
    <div className={cn("grid gap-4 md:grid-cols-2", className)}>
      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>Card spec</CardTitle>
          <CardDescription>
            Edit the description a model would produce, or pick a sample. It is compiled by the
            server's <code>/api/teams/card</code> route.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="teams-sample">Sample</Label>
            <Select value={String(sampleIndex)} onValueChange={chooseSample}>
              <SelectTrigger id="teams-sample" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CARD_SAMPLES.map((sample, index) => (
                  <SelectItem key={sample.label} value={String(index)}>
                    {sample.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            aria-label="Card spec JSON"
            className="min-h-72 font-mono text-xs"
            spellCheck={false}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSource(format(CARD_SAMPLES[sampleIndex]!.spec))}
            >
              Reset
            </Button>
            {error ? <span className="text-xs text-destructive">{error}</span> : null}
          </div>
        </CardContent>
      </Card>

      <Card className="min-h-0">
        <CardHeader>
          <CardTitle>Adaptive Card preview</CardTitle>
          <CardDescription>
            Rendered with the <code>adaptivecards</code> JavaScript renderer, the same one Teams
            preview tools embed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <AdaptiveCardView card={result.card} className="ac-container" />
          ) : (
            <p className="text-sm text-muted-foreground">No card yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
