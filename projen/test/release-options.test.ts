import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseReleaseTagAnnotation,
  releasePublishesLocally,
  releaseStepSelection,
  releaseTagAnnotation,
  type ReleaseSelectionOptions,
} from "../src/release-options.ts";
import { releaseBuildSteps } from "../src/release.ts";
import { createReleaseCommand } from "../tasks/release.ts";

async function flags(args: string[]): Promise<
  ReleaseSelectionOptions & {
    install: string;
    localPublish: boolean;
    demoDeploy?: boolean;
    releaseNotes?: boolean;
  }
> {
  const command = createReleaseCommand().action(() => {});
  await command.parseAsync(args, { from: "user" });
  return command.opts();
}

describe("per-run release selection", () => {
  it("retains all default publication, validation, and auto-install behavior", async () => {
    const options = await flags([]);
    assert.deepEqual(releaseStepSelection(options), {
      npm: true,
      pypi: true,
      docs: true,
      validation: true,
    });
    assert.equal(options.install, "auto");
    assert.equal(options.localPublish, true);
    assert.equal(options.demoDeploy, undefined);
    assert.equal(options.releaseNotes, true);
    assert.equal(releaseTagAnnotation("v1.2.3", releaseStepSelection(options)), "v1.2.3");
    assert.equal(releasePublishesLocally(options.publish), true);
  });

  it("selects PyPI alone without local registry publication or documentation", async () => {
    const options = await flags(["--publish", "pypi", "--no-docs"]);
    assert.deepEqual(releaseStepSelection(options), {
      npm: false,
      pypi: true,
      docs: false,
      validation: true,
    });
    assert.equal(releasePublishesLocally(options.publish), false);
  });

  it("selects local publication without remote artifacts and can opt back into docs", async () => {
    const options = await flags(["--publish", "local", "--install", "never"]);
    assert.deepEqual(releaseStepSelection(options), {
      npm: false,
      pypi: false,
      docs: false,
      validation: true,
    });
    assert.equal(options.install, "never");
    assert.equal(releasePublishesLocally(options.publish), true);
    assert.equal(releaseStepSelection(await flags(["--publish", "local", "--docs"])).docs, true);
  });

  it("supports individual switches without changing following releases", async () => {
    const options = await flags([
      "--no-npm",
      "--no-pypi",
      "--no-docs",
      "--no-validation",
      "--no-local-publish",
    ]);
    assert.deepEqual(releaseStepSelection(options), {
      npm: false,
      pypi: false,
      docs: false,
      validation: false,
    });
    assert.equal(options.localPublish, false);
    assert.deepEqual(releaseStepSelection(await flags([])), {
      npm: true,
      pypi: true,
      docs: true,
      validation: true,
    });
  });

  it("round-trips CI selections through the annotated tag without leaking local configuration", () => {
    const selection = releaseStepSelection({ publish: "pypi", docs: false });
    const annotation = releaseTagAnnotation("v1.2.3", selection);
    assert.deepEqual(parseReleaseTagAnnotation(annotation), selection);
    assert.deepEqual(parseReleaseTagAnnotation("v1.2.3\n"), releaseStepSelection());
    assert.doesNotMatch(annotation, /registry|install|localhost|demo|notes/);
  });

  it("opts into demo-app deploy without recording it in the annotated tag", async () => {
    const options = await flags(["--demo-deploy"]);
    assert.equal(options.demoDeploy, true);
    assert.deepEqual(releaseStepSelection(options), {
      npm: true,
      pypi: true,
      docs: true,
      validation: true,
    });
    assert.equal(releaseTagAnnotation("v1.2.3", releaseStepSelection(options)), "v1.2.3");
  });

  it("opts out of release notes without recording it in the annotated tag", async () => {
    const options = await flags(["--no-release-notes"]);
    assert.equal(options.releaseNotes, false);
    assert.equal(releaseTagAnnotation("v1.2.3", releaseStepSelection(options)), "v1.2.3");
  });

  it("rejects malformed or ambiguous policies rather than enabling unselected publication", () => {
    for (const body of [
      "{}",
      '{"npm":"false","pypi":true,"docs":true,"validation":true}',
      "not-json",
    ]) {
      assert.throws(
        () => parseReleaseTagAnnotation(`v1.2.3\ndbx-tools-release: ${body}`),
        /Invalid release/,
      );
    }
    const annotation = releaseTagAnnotation("v1.2.3", releaseStepSelection({ docs: false }));
    assert.throws(
      () => parseReleaseTagAnnotation(`${annotation}\n${annotation}`),
      /multiple step selections/,
    );
  });

  it("preserves native step conditions while applying the selected artifact scope", () => {
    const steps = releaseBuildSteps("docs", [
      { name: "Build docs", run: "bun build-docs", if: "${{ env.BUILD_DOCS != 'false' }}" },
    ]);
    assert.equal(
      steps[0]?.if,
      "${{ success() && steps.release.outputs.docs == 'true' && (env.BUILD_DOCS != 'false') }}",
    );
  });
});
