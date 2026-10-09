import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { Tool } from "@mastra/core/tools";
import { CatalogueSkillSearchProcessor } from "../src/skill-search.ts";

describe("CatalogueSkillSearchProcessor", () => {
  it("searches metadata, loads instructions, and reads auxiliary files lazily", async () => {
    const reads: string[] = [];
    const owner = {
      async get() {
        return {
          version: 1,
          generatedAt: new Date().toISOString(),
          roots: ["team"],
          skills: [
            {
              name: "databricks-apps",
              description: "Build and operate Databricks Apps.",
              instructions: "Read references/deploy.md before deploying.",
              sourceId: "team",
              sourcePath: "databricks-apps/SKILL.md",
            },
          ],
        };
      },
      async readSkillFile(_skillName: string, path: string) {
        reads.push(path);
        return "Deploy reference";
      },
    };
    const processor = new CatalogueSkillSearchProcessor({
      resolve: async () => owner as never,
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-1");
    const systems: string[] = [];
    const step = async () =>
      processor.processInputStep({
        stepNumber: 0,
        requestContext,
        tools: {},
        messageList: {
          addSystem(value: string) {
            systems.push(value);
          },
        },
      } as never);

    const first = await step();
    const search = first.tools.search_skills as Tool;
    const load = first.tools.load_skill as Tool;
    const read = first.tools.skill_read as Tool;
    const searchResult = await search.execute?.({ query: "Databricks Apps" }, {});
    assert.equal((searchResult as { results: Array<{ name: string }> }).results[0]?.name, "databricks-apps");
    assert.equal(reads.length, 0);

    assert.deepEqual(await load.execute?.({ skillName: "databricks-apps" }, {}), {
      success: true,
      message: 'Skill "databricks-apps" loaded. Its instructions are now available as context.',
      skillName: "databricks-apps",
    });
    await step();
    assert.ok(systems.some((message) => message.includes("[Skill: databricks-apps]")));
    assert.equal(
      await read.execute?.(
        {
          skillName: "databricks-apps",
          path: "references/deploy.md",
        },
        {},
      ),
      "Deploy reference",
    );
    assert.deepEqual(reads, ["references/deploy.md"]);
  });
});
