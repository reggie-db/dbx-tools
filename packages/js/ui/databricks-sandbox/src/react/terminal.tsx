import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@dbx-tools/ui/react";
import { useEffect, useRef } from "react";

/** Props for the workspace-API-backed Databricks Sandbox terminal. */
export interface SandboxTerminalProps {
  machineId: string;
  basePath?: string;
  className?: string;
}

/** Interactive PTY terminal transported through the Databricks workspace gRPC API. */
export function SandboxTerminal({
  machineId,
  basePath = "/api/databricks-sandbox",
  className,
}: SandboxTerminalProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 14,
      theme: { background: "#0b1020", foreground: "#e5e7eb", cursor: "#f8fafc" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    terminal.writeln(`Connecting to ${machineId}...`);
    const controller = new AbortController();
    const path = `${basePath}/machines/${encodeURIComponent(machineId)}/terminal/stream`;
    const url = new URL(path, window.location.origin);
    url.searchParams.set("cols", String(terminal.cols));
    url.searchParams.set("rows", String(terminal.rows));
    let sessionId: string | undefined;
    const pending: string[] = [];
    let inputQueue = Promise.resolve();
    const send = (data: string) => {
      if (!sessionId) {
        pending.push(data);
        return;
      }
      const currentSession = sessionId;
      inputQueue = inputQueue.then(async () => {
        const response = await fetch(`${basePath}/terminal/sessions/${currentSession}/input`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data }),
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Terminal input failed (${response.status})`);
        }
      });
      inputQueue.catch((error) => terminal.writeln(`\r\n${String(error)}`));
    };
    void fetch(url, {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Terminal stream failed (${response.status})`);
        sessionId = response.headers.get("x-terminal-session-id") ?? undefined;
        if (!sessionId) throw new Error("Terminal stream did not return a session id");
        terminal.clear();
        for (const data of pending.splice(0)) send(data);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Terminal stream has no response body");
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          terminal.write(chunk.value);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) terminal.writeln(`\r\n${String(error)}`);
      });
    const input = terminal.onData((data) => {
      send(data);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    return () => {
      observer.disconnect();
      input.dispose();
      controller.abort();
      if (sessionId) {
        void fetch(`${basePath}/terminal/sessions/${sessionId}`, {
          method: "DELETE",
          credentials: "same-origin",
          keepalive: true,
        });
      }
      terminal.dispose();
    };
  }, [basePath, machineId]);

  return (
    <div ref={container} className={cn("h-full min-h-80 w-full bg-[#0b1020] p-2", className)} />
  );
}
