import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  usePluginClientConfig,
} from "@databricks/appkit-ui/react";
import { defaultBrandContext, type BrandContext } from "@dbx-tools/shared-core";
import { emailBrandFromContext, type EmailBrand } from "@dbx-tools/shared-email-template";
import {
  GENERATOR_PLUGIN_NAME,
  GeneratorPluginClient,
  type GeneratorClientConfig,
  type BrandGenerationProgressEvent,
  type BrandGenerationStage,
  type BrandPackage,
} from "@dbx-tools/shared-generator";
import { BrandIcon, useBrand } from "@dbx-tools/ui/branding/react";
import { EmailPreview } from "@dbx-tools/ui/email/react";
import { BrandPicker, type BrandPreset } from "@dbx-tools/ui/react";
import { CheckCircle2, Circle, CircleX, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const SITE_PRESETS: readonly BrandPreset[] = [
  {
    id: "dbx-tools",
    label: "dbx tools",
    description: "Navy with green accent",
    context: defaultBrandContext,
  },
  {
    id: "lakehouse",
    label: "Lakehouse",
    description: "Cool blue data palette",
    context: {
      colors: {
        primary: "#2563EB",
        primaryHover: "#1D4ED8",
        accent: "#06B6D4",
        foreground: "#172554",
        background: "#F8FAFC",
        surface: "#EFF6FF",
        muted: "#64748B",
        border: "#BFDBFE",
      },
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Dark indigo operations theme",
    context: {
      colors: {
        primary: "#8B5CF6",
        primaryHover: "#7C3AED",
        accent: "#22D3EE",
        foreground: "#E2E8F0",
        background: "#0F172A",
        surface: "#1E293B",
        muted: "#94A3B8",
        border: "#334155",
      },
    },
  },
];

const GENERATION_STAGES: readonly BrandGenerationStage[] = [
  "search",
  "visuals",
  "fetch",
  "assets",
  "synthesize",
];

const GENERATION_STAGE_LABELS: Record<BrandGenerationStage, string> = {
  search: "Find official sources",
  fetch: "Read cited pages",
  visuals: "Review mobile app references",
  assets: "Inspect brand artwork",
  synthesize: "Build brand context",
};

const digestEmail = {
  to: ["data-platform@databricks.com"],
  subject: "Your weekly workspace digest",
  body: `## Production is healthy

Your team completed **1,284 successful runs** this week with a 99.7% success rate.

| Workflow | Status | Median duration |
| --- | --- | ---: |
| Customer 360 refresh | Healthy | 8m 42s |
| Feature pipeline | Healthy | 3m 18s |
| Executive metrics | Review | 12m 05s |

### Recommended next steps

- Review the two retries on **Executive metrics**.
- Promote the validated feature table to production.
- Archive seven unused development endpoints.

[Open the operations dashboard](https://example.com/operations)`,
};

const launchEmail = {
  to: ["builders@databricks.com"],
  cc: ["field-engineering@databricks.com"],
  subject: "Now available: governed agent workflows",
  body: `# Ship agents with confidence

The new release combines governed tools, durable memory, and human approval in one AppKit-ready workflow.

> Every external action remains reviewable before execution.

**Included in this release**

1. Streaming multi-thread conversations
2. Approval-gated email and external actions
3. Lakebase-backed memory and audit history
4. Brand-aware UI and outbound messages

Reply with your use case and we will help map the first production workflow.`,
  attachments: [{ filename: "agent-launch-guide.pdf", contentType: "application/pdf" }],
};

const campaignEmail = {
  to: ["community@example.com"],
  subject: "Northstar Sessions · New York",
  body: `# Build what moves the business

Join **Northstar Sessions** for an evening of practical architecture stories, live product demos, and small-group design reviews.

### Tuesday, September 15

**5:30 PM** · Doors and dinner  
**6:15 PM** · Production AI systems, unpacked  
**7:00 PM** · Builder labs and office hours

Seats are intentionally limited so every attendee leaves with an actionable plan.

[Reserve your seat](https://example.com/northstar)`,
};

const NORTHSTAR_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%236D28D9'/%3E%3Cpath d='M32 11l5.8 14.2L53 27l-11.5 9.8L45 52l-13-8-13 8 3.5-15.2L11 27l15.2-1.8L32 11z' fill='%23fff'/%3E%3C/svg%3E";

const campaignBrand = {
  accent: "#6D28D9",
  onAccent: "#FFFFFF",
  fontFamily: "Georgia, 'Times New Roman', serif",
  name: "Northstar Sessions",
  background: "#F5F3FF",
  surface: "#FFFFFF",
  foreground: "#2E1065",
  muted: "#6B5A86",
  border: "#DDD6FE",
  tagline: "Ideas for teams building what comes next.",
  website: "https://example.com/northstar",
  logoUrl: NORTHSTAR_ICON,
} satisfies EmailBrand;

interface BrandGeneratorProps {
  onGenerated: (brand: BrandContext) => void;
}

const BrandGenerator = ({ onGenerated }: BrandGeneratorProps) => {
  const config = usePluginClientConfig<GeneratorClientConfig>(GENERATOR_PLUGIN_NAME);
  const client = useMemo(() => new GeneratorPluginClient(config), [config.basePath]);
  const [name, setName] = useState("Databricks");
  const [website, setWebsite] = useState("https://www.databricks.com/");
  const [progress, setProgress] = useState<
    Partial<Record<BrandGenerationStage, BrandGenerationProgressEvent>>
  >({});
  const [generated, setGenerated] = useState<BrandPackage>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController>();

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const generate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || running) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(undefined);
    setGenerated(undefined);
    setProgress({});
    let completed = false;

    try {
      for await (const update of client.generate(
        {
          name: name.trim(),
          ...(website.trim() ? { website: website.trim() } : {}),
        },
        { signal: controller.signal },
      )) {
        if (update.type === "progress") {
          setProgress((current) => ({ ...current, [update.stage]: update }));
          continue;
        }
        if (update.type === "error") throw new Error(update.message);
        completed = true;
        setGenerated(update.package);
        onGenerated(update.package.brand);
      }
      if (!completed) throw new Error("Brand generation ended before returning a package.");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Brand generation failed.");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setRunning(false);
      }
    }
  };

  const activeStage = [...GENERATION_STAGES].reverse().find((stage) => progress[stage]);
  const activeIndex = activeStage ? GENERATION_STAGES.indexOf(activeStage) : -1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate from a brand</CardTitle>
        <CardDescription>
          Research official sources, build a portable context, and apply it to this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form className="space-y-4" onSubmit={generate}>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Brand name</span>
            <Input
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              placeholder="Databricks"
              required
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Official website</span>
            <Input
              type="url"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="https://www.example.com/"
            />
            <span className="block text-xs font-normal text-muted-foreground">
              Optional. Use it to distinguish brands with similar names.
            </span>
          </label>
          <Button type="submit" disabled={running || !name.trim()}>
            {running ? (
              <>
                <LoaderCircle className="motion-safe:animate-spin" />
                Generating
              </>
            ) : (
              "Generate and apply"
            )}
          </Button>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </form>

        <div className="space-y-3" aria-live="polite">
          <p className="text-sm font-medium text-foreground">
            {generated
              ? `Applied ${generated.brand.name}`
              : running
                ? "Generation activity"
                : error
                  ? "Generation failed"
                  : "Ready"}
          </p>
          <ol className="space-y-2">
            {GENERATION_STAGES.map((stage, index) => {
              const update = progress[stage];
              const complete = Boolean(generated) || (activeIndex >= 0 && index < activeIndex);
              const active = running && stage === activeStage;
              const failed = Boolean(error) && stage === activeStage;
              return (
                <li key={stage} className="flex gap-2.5 text-sm">
                  {complete ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : active ? (
                    <LoaderCircle className="mt-0.5 size-4 shrink-0 text-primary motion-safe:animate-spin" />
                  ) : failed ? (
                    <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
                  )}
                  <div className="min-w-0">
                    <p
                      className={
                        failed
                          ? "text-destructive"
                          : complete || active
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {GENERATION_STAGE_LABELS[stage]}
                    </p>
                    {update ? (
                      <p className="truncate text-xs text-muted-foreground">{update.message}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {generated?.sources.length ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">
                Sources ({generated.sources.length})
              </summary>
              <ul className="mt-2 space-y-1.5">
                {generated.sources.map((source) => (
                  <li key={source.url} className="truncate">
                    <a
                      className="hover:text-foreground hover:underline"
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {source.title ?? new URL(source.url).hostname}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
};

interface BrandPageProps {
  value: BrandContext;
  onChange: (value: BrandContext) => void;
}

const BrandPage = ({ value, onChange }: BrandPageProps) => {
  const { context, resolveAsset } = useBrand();
  const siteEmailBrand = {
    ...emailBrandFromContext(context),
    logoUrl: resolveAsset(context.assets.icon.light),
  } satisfies EmailBrand;
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-6 md:px-6 md:py-10">
        <section className="space-y-2">
          <Badge variant="secondary">Live theme lab</Badge>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Brand</h1>
          <p className="max-w-3xl text-sm text-muted-foreground md:text-base">
            Edit the portable brand context once and watch AppKit tokens, document metadata, icons,
            and standard email previews update together.
          </p>
        </section>

        <BrandGenerator onGenerated={onChange} />

        <BrandPicker value={value} onChange={onChange} presets={SITE_PRESETS} />

        <Card>
          <CardHeader>
            <CardTitle>Current site identity</CardTitle>
            <CardDescription>The active `BrandProvider` context used by this page.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-4">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <BrandIcon className="size-9" mode="light" />
            </div>
            <div>
              <p className="text-xl font-semibold text-foreground">{context.name}</p>
              <p className="text-sm text-muted-foreground">{context.tagline}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(context.colors).map(([name, color]) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs text-foreground"
                  >
                    <span
                      className="size-2.5 rounded-full border border-black/10"
                      style={{ backgroundColor: color }}
                    />
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <section className="space-y-4">
          <div>
            <h2 className="text-2xl font-semibold text-foreground">Rich email templates</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              The first two previews inherit the live site brand. The final campaign deliberately
              uses a dedicated email-only identity.
            </p>
          </div>
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Operational digest</CardTitle>
                <CardDescription>
                  Live site brand · received-mail chrome around the delivered card.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-2xl border border-border/70 bg-muted/30 p-2 sm:p-3">
                  <EmailPreview email={digestEmail} brand={siteEmailBrand} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Product launch</CardTitle>
                <CardDescription>
                  Live site brand · announcement chrome with attachment chip.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-2xl border border-border/70 bg-muted/30 p-2 sm:p-3">
                  <EmailPreview email={launchEmail} brand={siteEmailBrand} />
                </div>
              </CardContent>
            </Card>

            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Dedicated campaign brand</CardTitle>
                <CardDescription>
                  Intentionally independent from the picker for a partner or event identity.
                </CardDescription>
              </CardHeader>
              <CardContent className="mx-auto max-w-3xl">
                <div className="rounded-2xl border border-border/70 bg-muted/30 p-2 sm:p-3">
                  <EmailPreview email={campaignEmail} brand={campaignBrand} />
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
};

export default BrandPage;
