import { bundle } from "../../index.ts";

const [projectBoundary, cwd, limit] = process.argv.slice(2);
if (!projectBoundary) throw new Error("project boundary is required");

const maximum = limit ? Number.parseInt(limit, 10) : undefined;
const resources: Record<string, unknown>[] = [];
for await (const { bundleFailure, ...resource } of bundle.appResources(projectBoundary, cwd)) {
  resources.push({
    ...resource,
    ...((bundleFailure && { bundleFailure: bundleFailure.message }) ?? {}),
  });
  if (maximum !== undefined && resources.length >= maximum) break;
}

process.stdout.write(JSON.stringify(resources));
