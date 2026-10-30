/**
 * Reasoning-effort adaptation for gateway round trips.
 *
 * Proactively remaps client efforts onto the known ladder, then on a single
 * unsupported-value 400 resolves the preferred published-or-learned ladder
 * and retries once.
 *
 * @module
 */

import {
  learnReasoningLevelsFromError,
  modelReasoningLevelsFor,
  adaptRequestReasoning,
  parseReasoningLevels,
} from "@dbx-tools/model";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("appkit/model-gateway/reasoning");
const INVALID_ENCRYPTED_REASONING_PATTERN =
  /invalid encrypted reasoning|invalid_encrypted_content|encrypted content .+ could not be verified/i;
const REASONING_UNSUPPORTED_PATTERN = /does not support ['"]reasoning['"]/i;

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
 * On a reasoning-related 400, remove invalid replay state, remove unsupported
 * reasoning, or resolve the preferred ladder and produce a remapped retry body.
 * Returns `undefined` when no retry should occur.
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

  const serializedError = JSON.stringify(errorBody);
  if (INVALID_ENCRYPTED_REASONING_PATTERN.test(serializedError)) {
    const stripped = stripReasoningHistory(input.body);
    if (!stripped) return undefined;
    logger.info("retrying without invalid encrypted reasoning history", { model: input.model });
    return stripped;
  }

  if (REASONING_UNSUPPORTED_PATTERN.test(serializedError)) {
    const stripped = stripRequestReasoning(input.body);
    if (!stripped) return undefined;
    logger.info("retrying without unsupported reasoning", { model: input.model });
    return stripped;
  }

  if (parseReasoningLevels(errorBody).length === 0) return undefined;

  const levels = await learnReasoningLevelsFromError(input.model, errorBody);
  logger.info("resolved reasoning levels after upstream error", {
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

function stripReasoningHistory(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!Array.isArray(body.input)) return undefined;
  const input = body.input.filter((item) => !isRecord(item) || item.type !== "reasoning");
  if (input.length === body.input.length) return undefined;
  return { ...body, input };
}

function stripRequestReasoning(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!Object.hasOwn(body, "reasoning") && !Object.hasOwn(body, "reasoning_effort")) {
    return undefined;
  }
  const stripped = { ...body };
  delete stripped.reasoning;
  delete stripped.reasoning_effort;
  return stripped;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
