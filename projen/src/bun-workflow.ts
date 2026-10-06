/** Shared Bun setup for generated workflows. */

export const BUN_VERSION = "1.3.14";

/** Install the pinned Bun version. */
export function bunSetupStep(): Readonly<Record<string, unknown>> {
  return {
    name: "Setup Bun",
    uses: "oven-sh/setup-bun@v2",
    with: { "bun-version": "${{ env.BUN_VERSION }}" },
  };
}
