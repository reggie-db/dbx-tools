import { brand } from "@dbx-tools/shared-core";
import {
  Badge,
  BrandPicker,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type BrandPreset,
} from "@dbx-tools/ui-appkit/react";
import { BrandIcon, useBrand } from "@dbx-tools/ui-branding/react";
import { EmailPreview } from "@dbx-tools/ui-email/react";

const SITE_PRESETS: readonly BrandPreset[] = [
  {
    id: "dbx-tools",
    label: "dbx tools",
    description: "Warm red with green accent",
    context: brand.defaultBrandContext,
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

const digestEmail = {
  to: ["data-platform@databricks.com"],
  subject: "Your weekly workspace digest",
  body: `## Production is healthy

Your team completed **1,284 successful runs** this week with a 99.7% success rate.

| Workflow | Status | Median duration |
| --- | --- | ---: |
| Customer 360 refresh | ✅ Healthy | 8m 42s |
| Feature pipeline | ✅ Healthy | 3m 18s |
| Executive metrics | ⚠️ Review | 12m 05s |

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
2. Approval-gated email and Teams actions
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
};

interface BrandPageProps {
  value: brand.BrandContext;
  onChange: (value: brand.BrandContext) => void;
}

const BrandPage = ({ value, onChange }: BrandPageProps) => {
  const { context } = useBrand();
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
                <EmailPreview email={digestEmail} />
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
                <EmailPreview email={launchEmail} />
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
                <EmailPreview email={campaignEmail} brand={campaignBrand} />
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
};

export default BrandPage;
