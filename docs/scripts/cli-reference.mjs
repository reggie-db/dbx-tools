import { Command } from "commander";

export const CLI_REFERENCE_START = "<!-- cli-reference:start -->";
export const CLI_REFERENCE_END = "<!-- cli-reference:end -->";

/** Render the actual Commander help for every visible command without running actions. */
export function commanderReference(program) {
  const sections = [];
  function visit(command, invocation) {
    command.helpOption(false).addHelpCommand(false).configureHelp({
      helpWidth: 100,
      showGlobalOptions: true,
    });
    let output = "";
    command.configureOutput({
      writeOut: (value) => {
        output += value;
      },
      getOutHasColors: () => false,
    });
    command.outputHelp();
    const help = output
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();
    sections.push(`### \`${invocation}\`\n\n\`\`\`text\n${help}\n\`\`\``);
    for (const child of command.createHelp().visibleCommands(command)) {
      visit(child, `${invocation} ${child.name()}`);
    }
  }
  const names = [program.name()];
  for (let parent = program.parent; parent; parent = parent.parent) names.unshift(parent.name());
  visit(program, names.join(" "));
  return sections.join("\n\n");
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
