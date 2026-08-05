import { project } from "../../index.ts";

const current = process.argv[2]!;
const other = process.argv[3]!;

process.chdir(current);
const currentValues = [
  project.npmRegistry()?.toString(),
  project.npmRegistry("")?.toString(),
  project.npmRegistry(process.cwd())?.toString(),
];
const otherValues = [
  project.npmRegistry(other)?.toString(),
  project.npmRegistry(other)?.toString(),
];

process.chdir(other);
const movedValues = [project.npmRegistry()?.toString(), project.npmRegistry()?.toString()];

process.stdout.write(
  `${JSON.stringify({ current: currentValues, other: otherValues, moved: movedValues })}\n`,
);
