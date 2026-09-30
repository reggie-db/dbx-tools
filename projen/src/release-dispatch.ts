/** Verified release context shared by every job in the unified workflow. */
import type { JobStep } from "projen/lib/github/workflows-model";

export const RELEASE_TAG = "${{ needs.verify-context.outputs.release_tag }}";
export const RELEASE_SHA = "${{ needs.verify-context.outputs.expected_sha }}";
export const RELEASE_VERSION = "${{ needs.verify-context.outputs.release_version }}";
export const RELEASE_SUMMARY_DIRECTORY = "docs/releases";
export const RELEASE_SUMMARY_PROVIDER_NAMES = ["cursor", "codex", "claude"] as const;
export type ReleaseSummaryProviderName = (typeof RELEASE_SUMMARY_PROVIDER_NAMES)[number];

/** Immutable repository path for one version's release summary. */
export function releaseSummaryFile(version: string, component?: string): string {
  const prefix = component ? `${component.replace(/[^a-zA-Z0-9-]+/g, "-")}-` : "";
  return `${RELEASE_SUMMARY_DIRECTORY}/${prefix}v${version.replace(/^v/, "")}.md`;
}

export const RELEASE_SUMMARY_FILE = releaseSummaryFile(RELEASE_VERSION);

/** Check out and verify the immutable commit selected by the release tag. */
export function releaseSourceSteps(): readonly JobStep[] {
  return [
    {
      name: "Checkout release commit",
      uses: "actions/checkout@v6",
      with: {
        ref: RELEASE_SHA,
        "fetch-depth": 1,
      },
    },
    {
      name: "Verify release source",
      shell: "bash",
      env: {
        RELEASE_TAG,
        EXPECTED_SHA: RELEASE_SHA,
      },
      run: [
        'git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
        'test "$(git cat-file -t "$RELEASE_TAG")" = "tag"',
        'test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$EXPECTED_SHA"',
        'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
      ].join("\n"),
    },
  ];
}
