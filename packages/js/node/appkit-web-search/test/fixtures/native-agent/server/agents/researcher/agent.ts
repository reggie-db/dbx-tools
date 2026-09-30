import { createAgent } from "@databricks/appkit/beta";

export default createAgent({
  name: "Researcher",
  default: true,
  model: "databricks-gpt-6-1-sol",
  instructions: "Research with the registered AppKit toolkits and cite evidence.",
  skills: ["research-policy"],
  tools: {},
});
