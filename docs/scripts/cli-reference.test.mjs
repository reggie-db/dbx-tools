import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command, Option } from "commander";
import { buildProgram as buildGraphitiProgram } from "../../packages/js/cli/graphiti/src/cli.ts";
import { buildServiceCommand } from "../../packages/js/cli/service/src/cli.ts";
import {
  CLI_REFERENCE_START,
  commanderReference,
  serviceReference,
  withCliReference,
} from "./cli-reference.mjs";

describe("parser-owned CLI references", () => {
  it("captures descriptions, defaults, choices, environment variables, aliases, and nested options", () => {
    const program = new Command("example").description("An example CLI");
    program.addOption(
      new Option("--format <format>", "Output format").choices(["json", "text"]).default("json"),
    );
    program.addOption(new Option("--profile <name>", "Workspace profile").env("EXAMPLE_PROFILE"));
    program.addHelpText("after", "\nAn extra usage note.\n");
    const service = program.command("service").description("Manage the service");
    service.command("install").alias("add").option("--no-start", "Install without starting");
    program.command("secret", { hidden: true });
    program.addOption(new Option("--internal", "Internal switch").hideHelp());
    program.action(() => assert.fail("Documentation must not run command actions"));
    const reference = commanderReference(program);
    assert.match(reference, /An example CLI/);
    assert.match(reference, /An extra usage note/);
    assert.match(reference, /choices: "json", "text", default: "json"/);
    assert.match(reference, /env: EXAMPLE_PROFILE/);
    assert.match(reference, /### `example service install`/);
    assert.match(reference, /install\|add/);
    assert.match(reference, /--no-start/);
    assert.match(reference, /\| Option \| Description \|/);
    assert.match(reference, /\| Command \| Description \|/);
    assert.doesNotMatch(reference, /Global options/);
    assert.doesNotMatch(reference, /--help|display help|secret|--internal/);
    const install = section(reference, "### `example service install`");
    assert.match(install, /--no-start/);
    assert.doesNotMatch(install, /--format|--profile/);
  });

  it("renders the real shared service commands without resolving a definition", () => {
    const reference = serviceReference(buildServiceCommand);
    for (const command of ["install", "start", "stop", "restart", "status", "uninstall"]) {
      assert.ok(reference.includes(`### \`<cli> service ${command}\``));
    }
    assert.match(reference, /--no-start/);
    assert.doesNotMatch(reference, /--help|display help/);
  });

  it("renders every Graphiti command and schema-derived option", () => {
    const reference = commanderReference(buildGraphitiProgram());
    for (const command of [
      "service",
      "service install",
      "service start",
      "service stop",
      "service restart",
      "service status",
      "service uninstall",
    ]) {
      assert.match(reference, new RegExp(`dbx graphiti ${command}`));
    }
    for (const option of [
      "--profile <value>",
      "--model <value>",
      "--embedder-model <value>",
      "--listen <value>",
      "--falkor-data-dir <value>",
      "--falkor-listen <value>",
      "--falkor-snapshot-seconds <value>",
    ]) {
      assert.ok(reference.includes(option), `missing ${option}`);
    }
    assert.doesNotMatch(reference, /dbx graphiti (?:start|up|down|env)(?:\s|`)/);
    assert.doesNotMatch(reference, /journal-database-url/);
    assert.doesNotMatch(reference, /--help|display help/);
  });

  it("documents parent flags only on the command that owns them", () => {
    const program = new Command("proxy")
      .option("--host <host>", "loopback listener host")
      .option("--profile <profile>", "exact Databricks profile");
    const service = program.command("service");
    service.command("install").option("--host <host>", "loopback listener host");
    service.command("uninstall").description("Stop and remove the service");
    const reference = commanderReference(program);
    const root = section(reference, "### `proxy`");
    const install = section(reference, "### `proxy service install`");
    const uninstall = section(reference, "### `proxy service uninstall`");
    assert.match(root, /--profile/);
    assert.match(install, /--host/);
    assert.doesNotMatch(install, /--profile/);
    assert.doesNotMatch(uninstall, /--host|--profile|#### Options/);
  });

  it("preserves handwritten guidance and updates generated output deterministically", () => {
    const readme = "# Example\n\nUser guidance.\n";
    const generated = withCliReference(readme, "Original reference");
    assert.ok(generated.startsWith(readme));
    assert.equal(withCliReference(generated, "Original reference"), generated);
    const withFooter = `${generated}\n## Troubleshooting\n\nMore guidance.\n`;
    const updated = withCliReference(withFooter, "New reference");
    assert.ok(updated.endsWith("## Troubleshooting\n\nMore guidance.\n"));
    assert.ok(updated.includes("New reference"));
    assert.ok(!updated.includes("Original reference"));
  });

  it("rejects malformed markers rather than overwriting prose", () => {
    assert.throws(() => withCliReference(CLI_REFERENCE_START, "reference"), /marker pair/);
    const generated = withCliReference("# Example", "reference");
    assert.throws(
      () => withCliReference(`${generated}\n${CLI_REFERENCE_START}`, "reference"),
      /marker pair/,
    );
  });

  it("reflects an option change without maintaining a second option catalogue", () => {
    const program = new Command("example");
    const before = withCliReference("# Example\n", commanderReference(program));
    program.option("--timeout <seconds>", "Startup timeout", "30");
    const after = withCliReference(before, commanderReference(program));
    assert.notEqual(after, before);
    assert.match(after, /--timeout <seconds>/);
    assert.match(after, /Startup timeout \(default: "30"\)/);
  });
});

function section(reference, heading) {
  const start = reference.indexOf(heading);
  assert.ok(start >= 0, `missing ${heading}`);
  const rest = reference.slice(start);
  const next = rest.slice(heading.length).search(/\n### /);
  return next < 0 ? rest : rest.slice(0, heading.length + next);
}
