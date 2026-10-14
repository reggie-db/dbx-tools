import { MastraChat } from "@dbx-tools/ui-mastra/react";
import { useChatThreadQuery } from "@/hooks/use-chat-thread-query";

// The Chat surface pointed straight at the default Genie space: no agent or
// model. Genie conversations are the threads and Genie messages the history.

const GenieChat = () => {
  const thread = useChatThreadQuery();

  return (
    <MastraChat
      genieSpace="default"
      threadId={thread.threadId}
      onThreadIdChange={thread.onThreadIdChange}
      enableExport
      className="min-h-0 flex-1"
    />
  );
};

export default GenieChat;
