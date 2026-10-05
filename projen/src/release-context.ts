/** Verified release context shared by every job in the unified workflow. */
import { github } from "projen";
import type { JobStep } from "projen/lib/github/workflows-model";

export const RELEASE_TAG = "${{ needs.verify-context.outputs.release_tag }}";
export const RELEASE_SHA = "${{ needs.verify-context.outputs.expected_sha }}";
export const RELEASE_VERSION = "${{ needs.verify-context.outputs.release_version }}";

/** Check out and verify the immutable commit selected by the release tag. */
export function releaseSourceSteps(): readonly JobStep[] {
  return [
    github.WorkflowSteps.checkout({
      name: "Checkout release commit",
      with: {
        ref: RELEASE_SHA,
        fetchDepth: 1,
      },
    }),
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
