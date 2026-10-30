import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@databricks/appkit-ui/react";
import { getAuthStatus } from "@dbx-tools/shared-auth";
import { MastraChat, useChatThreadQuery } from "@dbx-tools/ui-mastra/react";
import { BarChart3Icon, SettingsIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

// Focused chat surface: streaming, tool-session pills, approvals, model
// selection, history, threads, export, and direct Genie selection.

type ChatSettingsMenu = "history" | "sidebar";

const Chat = () => {
  const [genieOnly, setGenieOnly] = useState(false);
  const [genieCharts, setGenieCharts] = useState(false);
  const [genieAvailable, setGenieAvailable] = useState(false);
  const [openSettingsMenu, setOpenSettingsMenu] = useState<ChatSettingsMenu | null>(null);
  const agentThread = useChatThreadQuery("thread");
  const genieThread = useChatThreadQuery("genieThread");
  const directGenie = genieOnly && genieAvailable;
  const genieVisualization = genieCharts ? "image" : "appkit";
  const thread = directGenie ? genieThread : agentThread;

  useEffect(() => {
    let cancelled = false;
    void getAuthStatus()
      .then((status) => {
        if (cancelled) return;
        const available = !status.enabled;
        setGenieAvailable(available);
        if (!available) {
          setGenieOnly(false);
          setOpenSettingsMenu(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGenieAvailable(false);
          setGenieOnly(false);
          setOpenSettingsMenu(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keepSettingsMenuOpen = (menu: ChatSettingsMenu) => {
    setOpenSettingsMenu(menu);
    window.setTimeout(() => setOpenSettingsMenu(menu), 0);
  };

  const preserveSettingsMenuSelection = (menu: ChatSettingsMenu) => (event: Event) => {
    event.preventDefault();
    keepSettingsMenuOpen(menu);
  };

  const chatSettings = (menu: ChatSettingsMenu) =>
    genieAvailable ? (
      <DropdownMenu
        open={openSettingsMenu === menu}
        onOpenChange={(open) => setOpenSettingsMenu(open ? menu : null)}
      >
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
        <DropdownMenuContent
          align="end"
          className="max-h-[calc(100dvh-1rem)] w-48 max-w-[calc(100vw-1rem)] overflow-y-auto"
        >
          <DropdownMenuCheckboxItem
            checked={genieOnly}
            onCheckedChange={(checked) => {
              setGenieOnly(checked === true);
              keepSettingsMenuOpen(menu);
            }}
            onSelect={preserveSettingsMenuSelection(menu)}
          >
            <SparklesIcon className="size-4 text-[#FF3621]" aria-hidden />
            Genie only
          </DropdownMenuCheckboxItem>
          {genieOnly ? (
            <DropdownMenuCheckboxItem
              checked={genieCharts}
              onCheckedChange={(checked) => {
                setGenieCharts(checked === true);
                keepSettingsMenuOpen(menu);
              }}
              onSelect={preserveSettingsMenuSelection(menu)}
            >
              <BarChart3Icon className="size-4" aria-hidden />
              Genie charts
            </DropdownMenuCheckboxItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <MastraChat
      key={directGenie ? `genie:${genieVisualization}` : "agent"}
      {...(directGenie
        ? { genieSpace: "default", genieVisualization }
        : { agentId: "support", showModelPicker: true })}
      threadId={thread.threadId}
      onThreadIdChange={thread.onThreadIdChange}
      enableExport
      threadHistoryLeadingActions={chatSettings("history")}
      threadSidebarHeaderActions={chatSettings("sidebar")}
      className="min-h-0 flex-1"
    />
  );
};

export default Chat;
