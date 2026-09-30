import { MastraChat } from "@dbx-tools/ui-mastra/react";
import { useState } from "react";

// Focused chat surface: streaming, tool-session pills, approvals, model
// selection, history, threads, export, and Genie transport selection.

const Chat = () => {
  const [agentMode, setAgentMode] = useState(true);
  const agentId = agentMode ? "support" : "support-polling";

  const agentModeControl = (
    <label
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-foreground hover:bg-accent"
      title={
        agentMode ? "Genie Agent Mode SSE is enabled" : "Genie Conversation API polling is enabled"
      }
    >
      <input
        id="genie-agent-mode"
        name="genie-agent-mode"
        type="checkbox"
        className="size-3.5 accent-primary"
        checked={agentMode}
        onChange={(event) => setAgentMode(event.target.checked)}
      />
      Genie Agent Mode
    </label>
  );

  return (
    <MastraChat
      key={agentId}
      agentId={agentId}
      showModelPicker
      enableExport
      modelSelectorActions={agentModeControl}
      className="min-h-0 flex-1"
    />
  );
};

export default Chat;
