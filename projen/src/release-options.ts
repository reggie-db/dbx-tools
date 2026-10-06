/**
 * Per-run release policy shared by the Projen task and tag-triggered workflow.
 *
 * This module owns defaults and the annotated-tag contract. Reuse these values
 * when adding release steps so local flags and CI cannot drift. Registry URLs
 * and local installation choices never belong in the public tag annotation.
 *
 * @module
 */
import { json } from "@dbx-tools/shared-core";
import { z } from "zod";

/** Publication scopes accepted by the release task; auto preserves normal publication. */
export const RELEASE_PUBLISH_TARGETS = ["auto", "npm", "pypi", "local", "none"] as const;

/** One publication scope accepted by the release task. */
export type ReleasePublishTarget = (typeof RELEASE_PUBLISH_TARGETS)[number];

/** Native Projen dependency-install modes available during local release preparation. */
export const RELEASE_INSTALL_MODES = ["auto", "always", "never"] as const;

/** Local dependency-install behavior; auto retains Projen's normal trigger policy. */
export type ReleaseInstallMode = (typeof RELEASE_INSTALL_MODES)[number];

/** CI steps selected by an immutable release annotation. */
export const ReleaseStepSelectionSchema = z
  .object({
    npm: z.boolean().describe("Build and publish npm artifacts."),
    pypi: z.boolean().describe("Build and publish Python artifacts."),
    docs: z.boolean().describe("Build and deploy documentation."),
    validation: z.boolean().describe("Run repository validation tasks."),
  })
  .strict()
  .readonly()
  .describe("Immutable CI steps recorded in an annotated release tag.");

/** CI steps selected by an immutable release annotation. */
export type ReleaseStepSelection = z.infer<typeof ReleaseStepSelectionSchema>;

/** Flags consumed by the shared release-selection policy. */
export interface ReleaseSelectionOptions {
  readonly publish?: ReleasePublishTarget;
  readonly npm?: boolean;
  readonly pypi?: boolean;
  readonly docs?: boolean;
  readonly validation?: boolean;
}

const ANNOTATION_MARKER = "dbx-tools-release:";

/** Derive public build/publication steps without mutating repository configuration. */
export function releaseStepSelection(options: ReleaseSelectionOptions = {}): ReleaseStepSelection {
  const target = options.publish ?? "auto";
  return {
    npm: (target === "auto" || target === "npm") && options.npm !== false,
    pypi: (target === "auto" || target === "pypi") && options.pypi !== false,
    docs: options.docs ?? (target !== "local" && target !== "none"),
    validation: options.validation ?? true,
  };
}

/** Record non-default CI selections alongside the existing annotated release tag. */
export function releaseTagAnnotation(tag: string, selection: ReleaseStepSelection): string {
  if (selection.npm && selection.pypi && selection.docs && selection.validation) return tag;
  return `${tag}\n\n${ANNOTATION_MARKER} ${JSON.stringify(selection)}`;
}

/** Read the release selection, rejecting malformed or ambiguous annotated policy. */
export function parseReleaseTagAnnotation(annotation: string): ReleaseStepSelection {
  const selections = annotation.split("\n").filter((line) => line.startsWith(ANNOTATION_MARKER));
  if (selections.length === 0) return releaseStepSelection();
  if (selections.length !== 1) throw new Error("Release tag contains multiple step selections");
  const value = json.parseRecord(selections[0]!.slice(ANNOTATION_MARKER.length));
  const parsed = ReleaseStepSelectionSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid release tag step selection");
  return parsed.data;
}

/** Whether the selected release should inspect and publish configured local registries. */
export function releasePublishesLocally(target: ReleasePublishTarget = "auto"): boolean {
  return target === "auto" || target === "local";
}
