import { Command } from "commander";

export const CLI_REFERENCE_START = "<!-- cli-reference:start -->";
export const CLI_REFERENCE_END = "<!-- cli-reference:end -->";

/** Render Commander commands as markdown tables without running actions. */
export function commanderReference(program) {
  const sections = [];
  function visit(command, invocation) {
    prepareCommand(command);
    const helper = command.createHelp();
    const parts = [`### \`${invocation}\``];
    const description = helper.commandDescription(command).trim();
    if (description) parts.push(description);
    parts.push(`\`\`\`sh\n${helper.commandUsage(command).trim()}\n\`\`\``);
    const before = collectHelpText(command, "before");
    if (before) parts.push(before);
    const arguments_ = helper.visibleArguments(command);
    if (arguments_.length) {
      parts.push(
        "#### Arguments",
        markdownTable(
          ["Argument", "Description"],
          arguments_.map((argument) => [
            helper.argumentTerm(argument),
            helper.argumentDescription(argument),
          ]),
        ),
      );
    }
    const options = helper.visibleOptions(command).filter((option) => !isHelpOption(option));
    if (options.length) {
      parts.push("#### Options", optionTable(helper, options));
    }
    const children = helper.visibleCommands(command);
    if (children.length) {
      parts.push(
        "#### Commands",
        markdownTable(
          ["Command", "Description"],
          children.map((child) => [
            helper.subcommandTerm(child),
            helper.subcommandDescription(child),
          ]),
        ),
      );
    }
    const after = collectHelpText(command, "after");
    if (after) parts.push(after);
    sections.push(parts.join("\n\n"));
    for (const child of children) visit(child, `${invocation} ${child.name()}`);
  }
  prepareCommand(program);
  const names = [program.name()];
  for (let parent = program.parent; parent; parent = parent.parent) names.unshift(parent.name());
  visit(program, names.join(" "));
  return sections.join("\n\n");
}

function prepareCommand(command) {
  for (const option of command.options) {
    if ("schemaHelpDefault" in option) option.defaultValue = option.schemaHelpDefault;
  }
  command.helpOption(false).addHelpCommand(false);
}

function optionTable(helper, options) {
  return markdownTable(
    ["Option", "Description"],
    options.map((option) => [helper.optionTerm(option), helper.optionDescription(option)]),
  );
}

/** Build the shared service reference without resolving or installing a service. */
export function serviceReference(buildServiceCommand) {
  const program = new Command("<cli>");
  const service = buildServiceCommand(() => {
    throw new Error("Documentation generation must not resolve a service definition");
  });
  program.addCommand(service);
  return commanderReference(service);
}

/** Replace only the generated CLI section, rejecting incomplete or duplicate markers. */
export function withCliReference(readme, reference) {
  const starts = readme.split(CLI_REFERENCE_START).length - 1;
  const ends = readme.split(CLI_REFERENCE_END).length - 1;
  const block = `${CLI_REFERENCE_START}\n## Command Reference\n\n${reference.trim()}\n${CLI_REFERENCE_END}`;
  if (starts === 0 && ends === 0) return `${readme.trimEnd()}\n\n${block}\n`;
  if (starts !== 1 || ends !== 1)
    throw new Error("Expected one complete CLI reference marker pair");
  const start = readme.indexOf(CLI_REFERENCE_START);
  const end = readme.indexOf(CLI_REFERENCE_END);
  if (end < start) throw new Error("CLI reference end marker precedes its start");
  return `${readme.slice(0, start)}${block}${readme.slice(end + CLI_REFERENCE_END.length)}`;
}

function collectHelpText(command, position) {
  let output = "";
  const context = {
    error: false,
    command,
    write: (value) => {
      output += value;
    },
  };
  const chain = [];
  for (let current = command; current; current = current.parent) chain.push(current);
  if (position === "before") {
    for (const current of chain.toReversed()) current.emit("beforeAllHelp", context);
    command.emit("beforeHelp", context);
  } else {
    command.emit("afterHelp", context);
    for (const current of chain) current.emit("afterAllHelp", context);
  }
  return output.trim();
}

function isHelpOption(option) {
  return option.long === "--help" || option.short === "-h";
}

function markdownTable(headers, rows) {
  return [headers, headers.map(() => "---"), ...rows.map(markdownRow)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function markdownRow(row) {
  return row.map((value, index) => (index === 0 ? markdownTerm(value) : markdownCell(value)));
}

function markdownTerm(value) {
  return `\`${markdownCell(value).replaceAll("`", "\\`")}\``;
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .trim();
}
