// A few ready-made `CardSpec` samples the dev gallery starts from, so the
// preview shows something interesting before you edit anything. Each exercises
// a different combination of the spec's optional parts (subtitle, text, facts,
// actions).

import type { CardSpec } from "@dbx-tools/shared-teams";

/** A named sample card spec shown in the gallery picker. */
export interface CardSample {
  /** Label shown in the picker. */
  label: string;
  /** The spec to build/render. */
  spec: CardSpec;
}

/** The built-in sample specs. */
export const CARD_SAMPLES: CardSample[] = [
  {
    label: "Deployment",
    spec: {
      title: "Deployment succeeded",
      subtitle: "prod • 2 minutes ago",
      text: "The **api** service rolled out cleanly across all regions.",
      facts: [
        { title: "Version", value: "1.4.2" },
        { title: "Owner", value: "alice" },
        { title: "Duration", value: "3m 12s" },
      ],
      actions: [
        { title: "View run", url: "https://example.com/runs/42" },
        { title: "Rollback", url: "https://example.com/runs/42/rollback" },
      ],
    },
  },
  {
    label: "Incident",
    spec: {
      title: "PagerDuty: high latency",
      subtitle: "SEV-2 • checkout-service",
      text: "p95 latency exceeded 800ms for 5 minutes. Auto-scaling triggered.",
      facts: [
        { title: "Status", value: "Investigating" },
        { title: "On-call", value: "bob" },
        { title: "Started", value: "14:02 UTC" },
      ],
      actions: [{ title: "Open incident", url: "https://example.com/incidents/7" }],
    },
  },
  {
    label: "Simple note",
    spec: {
      title: "Weekly report is ready",
      text: "Numbers look healthy this week. See the dashboard for the breakdown.",
      actions: [{ title: "Open dashboard", url: "https://example.com/dashboard" }],
    },
  },
];
