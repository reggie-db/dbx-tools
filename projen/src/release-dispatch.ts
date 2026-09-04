/** Shared release events and immutable source verification. */
export const DOWNSTREAM_RELEASE_EVENT = "release";
export const RUST_RELEASE_EVENT = "rust-release";
export const RELEASE_TAG =
  "${{ github.event_name == 'repository_dispatch' && github.event.client_payload.release_tag || inputs.release_tag }}";
export const RELEASE_SHA =
  "${{ github.event_name == 'repository_dispatch' && github.event.client_payload.expected_sha || inputs.expected_sha }}";

/** Check out and verify the exact commit carried by a release event. */
export function releaseSourceSteps(): readonly Record<string, unknown>[] {
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
        'test -n "$RELEASE_TAG"',
        'test -n "$EXPECTED_SHA"',
        'git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
        'test "$(git rev-parse "$RELEASE_TAG^{commit}")" = "$EXPECTED_SHA"',
        'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
      ].join("\n"),
    },
  ];
}
