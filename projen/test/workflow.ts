import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly "continue-on-error"?: boolean;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}

export interface WorkflowJob {
  readonly needs?: string[];
  readonly permissions?: Record<string, string>;
  readonly environment?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly if?: string;
  readonly strategy?: {
    readonly matrix?: {
      readonly include?: readonly Record<string, unknown>[];
    };
  };
  readonly steps: WorkflowStep[];
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly on: Record<string, unknown>;
  readonly concurrency: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob>;
}

export function readWorkflow(directory: string, name = "release"): WorkflowDefinition {
  return parse(
    readFileSync(join(directory, ".github", "workflows", `${name}.yml`), "utf8"),
  ) as WorkflowDefinition;
}

export function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const result = job.steps.find((candidate) => candidate.name === name);
  assert.ok(result, `missing ${name} step`);
  return result;
}

export function workflowTrigger<T>(workflow: WorkflowDefinition, name: string): T {
  const trigger = workflow.on[name];
  assert.ok(trigger, `missing ${name} trigger`);
  return trigger as T;
}
