import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@dbx-tools/ui/react";
import { MastraChat } from "@dbx-tools/ui-mastra/react";
import { SettingsIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useChatThreadQuery } from "@/hooks/use-chat-thread-query";

// Focused chat surface: streaming, tool-session pills, approvals, model
// selection, history, threads, export, and direct Genie selection.

const Chat = () => {
  const [genieOnly, setGenieOnly] = useState(false);
  const agentThread = useChatThreadQuery("thread");
  const genieThread = useChatThreadQuery("genieThread");
  const thread = genieOnly ? genieThread : agentThread;

  const chatSettings = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Chat settings"
          title="Chat settings"
        >
          <SettingsIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuCheckboxItem checked={genieOnly} onCheckedChange={setGenieOnly}>
          <SparklesIcon className="size-4 text-[#FF3621]" aria-hidden />
          Genie only
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <MastraChat
      key={genieOnly ? "genie" : "agent"}
      {...(genieOnly ? { genieSpace: "default" } : { agentId: "support", showModelPicker: true })}
      threadId={thread.threadId}
      onThreadIdChange={thread.onThreadIdChange}
      enableExport
      threadSidebarHeaderActions={chatSettings}
      className="min-h-0 flex-1"
    />
  );
};

export default Chat;
