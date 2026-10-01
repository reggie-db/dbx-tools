import { projectUtils } from "../../index.ts";

const current = process.argv[2]!;
const other = process.argv[3]!;

process.chdir(current);
const currentValues = [
  projectUtils.npmRegistry()?.toString(),
  projectUtils.npmRegistry("")?.toString(),
  projectUtils.npmRegistry(process.cwd())?.toString(),
];
const otherValues = [
  projectUtils.npmRegistry(other)?.toString(),
  projectUtils.npmRegistry(other)?.toString(),
];

process.chdir(other);
const movedValues = [
  projectUtils.npmRegistry()?.toString(),
  projectUtils.npmRegistry()?.toString(),
];

process.stdout.write(
  `${JSON.stringify({ current: currentValues, other: otherValues, moved: movedValues })}\n`,
);
