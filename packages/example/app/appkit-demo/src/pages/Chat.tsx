import { MastraChat } from "@dbx-tools/ui-mastra/react";
import { useState } from "react";

// Focused chat surface: streaming, tool-session pills, approvals, model
// selection, history, threads, export, and Genie transport selection.

const Chat = () => {
  const [agentMode, setAgentMode] = useState(true);
  const agentId = agentMode ? "support" : "support-polling";

  const agentModeControl = (
    <label
      className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-foreground"
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
      Agent Mode
    </label>
  );

  return (
    <MastraChat
      key={agentId}
      agentId={agentId}
      showModelPicker
      enableExport
      composerActions={agentModeControl}
      className="min-h-0 flex-1"
    />
  );
};

export default Chat;
