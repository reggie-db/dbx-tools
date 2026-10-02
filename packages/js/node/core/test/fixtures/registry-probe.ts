import { projectUtils } from "../../index.ts";

const cwd = process.argv[2]!;
const overrideOnly = process.env.overrideOnly === "1";
const url = projectUtils.npmRegistry(cwd, overrideOnly ? { overrideOnly: true } : undefined);
process.stdout.write(`${JSON.stringify(url ? { hostname: url.hostname } : null)}\n`);
