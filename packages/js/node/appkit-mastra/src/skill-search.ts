/**
 * On-demand skill discovery backed by a materialized workspace catalogue.
 *
 * @module
 */

import { errorUtils } from "@dbx-tools/shared-core";
import type { ProcessInputStepArgs, Processor } from "@mastra/core/processors";
import { MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import Fuse from "fuse.js";
import { z } from "zod";
import type { SkillCatalogueResolver } from "./skill-cache.ts";

const DEFAULT_STATE_TTL_MS = 60 * 60 * 1000;

interface ThreadState {
  lastAccessed: number;
  skills: Map<string, string>;
}

/** Configuration for {@link CatalogueSkillSearchProcessor}. */
export interface CatalogueSkillSearchProcessorOptions {
  minScore?: number;
  resolve: SkillCatalogueResolver;
  topK?: number;
  ttlMs?: number;
}

/** Mastra-compatible search, load, and lazy-read tools over one cached catalogue. */
export class CatalogueSkillSearchProcessor implements Processor<"skill-catalogue-search"> {
  readonly id = "skill-catalogue-search";
  readonly name = "Skill Catalogue Search";
  readonly providesSkillDiscovery = "on-demand" as const;

  private readonly minScore: number;
  private readonly resolve: SkillCatalogueResolver;
  private readonly states = new Map<string, ThreadState>();
  private readonly topK: number;
  private readonly ttlMs: number;

  constructor(options: CatalogueSkillSearchProcessorOptions) {
    this.resolve = options.resolve;
    this.topK = options.topK ?? 5;
    this.minScore = options.minScore ?? 0.1;
    this.ttlMs = options.ttlMs ?? DEFAULT_STATE_TTL_MS;
  }

  async processInputStep(args: ProcessInputStepArgs): Promise<{ tools: Record<string, unknown> }> {
    const owner = await this.resolve(args);
    const catalogue = await owner.get(args.abortSignal);
    const state = this.threadState(args);
    args.messageList.addSystem(
      "To discover available skills, call search_skills with a keyword query. " +
        "To load a skill's instructions, call load_skill with the exact skill name. " +
        "Use skill_read only after loading a skill when its instructions require a reference, script, or asset.",
    );
    for (const [skillName, instructions] of state.skills) {
      args.messageList.addSystem(`[Skill: ${skillName}]\n\n${instructions}`);
    }
    const search = new Fuse(catalogue.skills, {
      includeScore: true,
      ignoreLocation: true,
      threshold: 1,
      keys: [
        { name: "name", weight: 0.5 },
        { name: "description", weight: 0.35 },
        { name: "instructions", weight: 0.15 },
      ],
    });
    return {
      tools: {
        ...(args.tools ?? {}),
        search_skills: createTool({
          id: "search_skills",
          description:
            "Search for available skills by keyword. Load a useful result with load_skill.",
          inputSchema: z.object({
            query: z.string().trim().min(1, "Query is required").describe("Search keywords."),
          }),
          outputSchema: z.object({
            results: z.array(
              z.object({
                name: z.string(),
                description: z.string(),
                score: z.number(),
              }),
            ),
            message: z.string(),
          }),
          execute: async ({ query }) => {
            const results = search
              .search(query)
              .map((result) => ({
                name: result.item.name,
                description:
                  result.item.description.length > 150
                    ? `${result.item.description.slice(0, 147)}...`
                    : result.item.description,
                score: Math.round((1 - (result.score ?? 1)) * 100) / 100,
              }))
              .filter(({ score }) => score >= this.minScore)
              .slice(0, this.topK);
            return {
              results,
              message:
                results.length === 0
                  ? `No skills found matching "${query}". Try different keywords.`
                  : `Found ${results.length} skill(s). Use load_skill with the exact skill name to load its instructions.`,
            };
          },
        }),
        load_skill: createTool({
          id: "load_skill",
          description: "Load a skill's full instructions into the conversation.",
          inputSchema: z.object({
            skillName: z.string().describe("Exact skill name returned by search_skills."),
          }),
          outputSchema: z.object({
            success: z.boolean(),
            message: z.string(),
            skillName: z.string().optional(),
          }),
          execute: async ({ skillName }) => {
            if (state.skills.has(skillName)) {
              return {
                success: true,
                message: `Skill "${skillName}" is already loaded.`,
                skillName,
              };
            }
            const skill = catalogue.skills.find(({ name }) => name === skillName);
            if (!skill) {
              return {
                success: false,
                message: `Skill "${skillName}" not found. Use search_skills to find available skills.`,
              };
            }
            state.skills.set(skillName, skill.instructions);
            return {
              success: true,
              message: `Skill "${skillName}" loaded. Its instructions are now available as context.`,
              skillName,
            };
          },
        }),
        skill_read: createTool({
          id: "skill_read",
          description:
            "Read a reference, script, template, or asset from a loaded skill. The path is relative to the skill root.",
          inputSchema: z.object({
            skillName: z.string().describe("Exact loaded skill name."),
            path: z.string().describe("File path relative to the skill root."),
            startLine: z.number().int().positive().optional(),
            endLine: z.number().int().positive().optional(),
          }),
          execute: async ({ skillName, path, startLine, endLine }) => {
            if (!state.skills.has(skillName)) {
              return `Skill "${skillName}" is not loaded. Call load_skill first.`;
            }
            try {
              const source = await owner.readSkillFile(skillName, path, args.abortSignal);
              return lineRange(source, path, startLine, endLine);
            } catch (error) {
              return `Could not read "${path}" from skill "${skillName}": ${errorUtils.errorMessage(error)}`;
            }
          },
        }),
      },
    };
  }

  private threadState(args: ProcessInputStepArgs): ThreadState {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (now - state.lastAccessed > this.ttlMs) this.states.delete(key);
    }
    const key = args.requestContext?.get(MASTRA_THREAD_ID_KEY) ?? "default";
    const current = this.states.get(String(key)) ?? {
      lastAccessed: now,
      skills: new Map<string, string>(),
    };
    current.lastAccessed = now;
    this.states.set(String(key), current);
    return current;
  }
}

function lineRange(
  source: string,
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (startLine === undefined && endLine === undefined) return source;
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  if (start > end || start > lines.length) {
    return `File "${path}" has ${lines.length} lines; requested range ${start}-${end} is empty.`;
  }
  return `${path} (lines ${start}-${end} of ${lines.length})\n${lines.slice(start - 1, end).join("\n")}`;
}
