import { MastraChat } from "@dbx-tools/ui-mastra/react";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useChatThreadQuery } from "@/hooks/use-chat-thread-query";

// Focused chat surface: streaming, tool-session pills, approvals, model
// selection, history, threads, export, and direct Genie selection.

const Chat = () => {
  const [genieOnly, setGenieOnly] = useState(false);
  const agentThread = useChatThreadQuery("thread");
  const genieThread = useChatThreadQuery("genieThread");
  const thread = genieOnly ? genieThread : agentThread;

  const genieOnlyControl = (
    <label
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-foreground hover:bg-accent"
      title="Use direct Genie conversations instead of the tool-using support agent"
    >
      <SparklesIcon className="size-4 shrink-0 text-[#FF3621]" aria-hidden />
      <input
        name="genie-only"
        type="checkbox"
        className="size-3.5 accent-primary"
        checked={genieOnly}
        onChange={(event) => setGenieOnly(event.target.checked)}
      />
      Genie only
    </label>
  );

  return (
    <MastraChat
      key={genieOnly ? "genie" : "agent"}
      {...(genieOnly ? { genieSpace: "default" } : { agentId: "support", showModelPicker: true })}
      threadId={thread.threadId}
      onThreadIdChange={thread.onThreadIdChange}
      enableExport
      threadSidebarHeaderActions={genieOnlyControl}
      className="min-h-0 flex-1"
    />
  );
};

export default Chat;
