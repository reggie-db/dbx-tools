/**
 * Reasoning-effort adaptation for gateway round trips.
 *
 * Proactively remaps client efforts onto the known ladder, then on a single
 * unsupported-value 400 learns from the error and retries once with the
 * updated ladder.
 *
 * @module
 */

import {
  learnReasoningLevelsFromError,
  modelReasoningLevelsFor,
} from "@dbx-tools/model/metadata";
import {
  adaptRequestReasoning,
  parseReasoningLevels,
} from "@dbx-tools/model/reasoning-translation";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("appkit/model-gateway/reasoning");

/** Result of the first proactive adaptation pass. */
export interface AdaptedInferenceBody {
  readonly body: Readonly<Record<string, unknown>>;
  readonly wireEffort?: string;
  readonly changed: boolean;
}

/** Adapt a request body onto the current known ladder for `model`. */
export function adaptInferenceReasoning(
  model: string,
  body: Readonly<Record<string, unknown>>,
): AdaptedInferenceBody {
  const adapted = adaptRequestReasoning(body, modelReasoningLevelsFor(model));
  if (adapted.changed) {
    logger.debug("adapted reasoning effort before upstream", {
      model,
      effort: adapted.wireEffort,
    });
  }
  return {
    body: adapted.body,
    wireEffort: adapted.wireEffort,
    changed: adapted.changed,
  };
}

/**
 * On an unsupported-reasoning 400, learn once and optionally produce a
 * remapped retry body. Returns `undefined` when no retry should occur.
 */
export async function learnAndAdaptReasoningRetry(input: {
  readonly model: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly response: Response;
  readonly previousWireEffort?: string;
}): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (input.response.ok || input.response.status !== 400) return undefined;

  let errorBody: unknown;
  try {
    errorBody = JSON.parse(await input.response.clone().text());
  } catch {
    return undefined;
  }

  if (parseReasoningLevels(errorBody).length === 0) return undefined;

  const levels = await learnReasoningLevelsFromError(input.model, errorBody);
  logger.info("learned reasoning levels from upstream error", {
    model: input.model,
    levels,
  });

  const adapted = adaptRequestReasoning(input.body, levels);
  if (adapted.wireEffort === undefined || adapted.wireEffort === input.previousWireEffort) {
    return undefined;
  }

  logger.info("retrying with adapted reasoning effort", {
    model: input.model,
    from: input.previousWireEffort,
    to: adapted.wireEffort,
  });
  return adapted.body;
}
