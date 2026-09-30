/**
 * Browser-safe model metadata projected from the Rust policy bindings.
 *
 * @module
 */

import {
  modelFamily as modelFamilyWithRust,
  reasoningEffortNamesByFamily,
} from "@dbx-tools/model-rs";
import type { ReasoningEffort } from "@dbx-tools/shared-model";

/** Return the normalized family parsed by the Rust model-name policy. */
export function modelFamily(name: string): string | undefined {
  return modelFamilyWithRust(name);
}

/** Return the reasoning efforts accepted by a model family. */
export function modelReasoningEfforts(name: string): ReasoningEffort[] {
  return reasoningEffortNamesByFamily(name);
}
