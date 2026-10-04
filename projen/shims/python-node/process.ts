import { installPythonGlobals } from "./host.ts";

installPythonGlobals();

export default process;
export const arch = process.arch;
export const argv = process.argv;
export const cwd = process.cwd;
export const env = process.env;
export const nextTick = process.nextTick;
export const platform = process.platform;
export const version = process.version;
export const versions = process.versions;
