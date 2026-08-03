import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  ScrollArea,
  cn,
} from "@dbx-tools/ui-appkit/react";
import { hash } from "@dbx-tools/shared-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = "/api/bus-demo";

type BusMessage = {
  id: string;
  topic: string;
  type: string;
  metadata: Record<string, unknown>;
  body: unknown;
  publishedAt: string;
};

type ConnectionState = "connecting" | "connected" | "reconnecting";

function sessionValue(key: string, create: () => string): string {
  const current = sessionStorage.getItem(key);
  if (current) return current;
  const value = create();
  sessionStorage.setItem(key, value);
  return value;
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseBody(value: string): unknown {
  if (!value.trim()) return "";
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

const Bus = () => {
  const viewerId = useMemo(() => sessionValue("dbx-tools-bus-viewer", () => hash.id()), []);
  const [user, setUser] = useState(() =>
    sessionValue("dbx-tools-bus-user", () => `Viewer ${viewerId.slice(0, 4).toUpperCase()}`),
  );
  const [type, setType] = useState("chat.message");
  const [metadataText, setMetadataText] = useState("{}");
  const [bodyText, setBodyText] = useState("");
  const [messages, setMessages] = useState<BusMessage[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);

  const mergeMessages = useCallback((incoming: BusMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, message);
      return [...byId.values()].slice(-200);
    });
  }, []);

  useEffect(() => {
    const source = new EventSource(`${API}/events`);
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("reconnecting");
    source.addEventListener("ready", () => setConnection("connected"));
    source.onmessage = (event) => {
      try {
        mergeMessages([JSON.parse(event.data) as BusMessage]);
      } catch {
        setError("A bus event could not be decoded.");
      }
    };
    return () => source.close();
  }, [mergeMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user.trim() || !type.trim() || sending) return;
    setSending(true);
    setError(undefined);
    sessionStorage.setItem("dbx-tools-bus-user", user.trim());
    try {
      const metadata = parseMetadata(metadataText);
      const body = parseBody(bodyText);
      const response = await fetch(`${API}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          viewerId,
          user: user.trim(),
          type: type.trim(),
          metadata,
          body,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          { error?: string } | undefined;
        throw new Error(body?.error ?? `Send failed (${response.status})`);
      }
      setBodyText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto grid h-full max-w-7xl gap-4 overflow-auto p-4 md:grid-cols-[24rem_1fr] md:overflow-hidden md:p-6">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Send to the bus</CardTitle>
          <CardDescription>
            Open this page in another tab or browser. Every viewer listens to the same
            Lakebase-backed topic. Notifications are live, so open the other viewer first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={send}>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Your name</span>
              <Input
                value={user}
                maxLength={80}
                onChange={(event) => setUser(event.target.value)}
                placeholder="Viewer name"
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Type</span>
              <Input
                value={type}
                maxLength={120}
                onChange={(event) => setType(event.target.value)}
                placeholder="chat.message"
              />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Metadata</span>
              <textarea
                className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-24 w-full resize-y rounded-md border px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                value={metadataText}
                onChange={(event) => setMetadataText(event.target.value)}
                placeholder='{"priority":"high"}'
                spellCheck={false}
              />
              <span className="text-muted-foreground block text-xs font-normal">
                JSON object. Project, public IP, machine, runtime, request, and viewer context are
                added when those keys are absent.
              </span>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Body</span>
              <textarea
                className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-32 w-full resize-y rounded-md border px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                value={bodyText}
                maxLength={5_000}
                onChange={(event) => setBodyText(event.target.value)}
                placeholder='Text, {"structured":"JSON"}, ["arrays"], 42, true, or null'
                spellCheck={false}
              />
            </label>
            <Button className="w-full" type="submit" disabled={sending || !type.trim()}>
              {sending ? "Sending…" : "Publish message"}
            </Button>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </form>
        </CardContent>
      </Card>

      <Card className="flex min-h-[28rem] flex-col overflow-hidden md:min-h-0">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Listener output</CardTitle>
            <CardDescription>
              Each notification includes its structured body and merged metadata context.
            </CardDescription>
          </div>
          <Badge variant={connection === "connected" ? "default" : "secondary"}>{connection}</Badge>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          <ScrollArea className="h-full px-6 pb-6">
            <div className="space-y-3">
              {messages.length === 0 ? (
                <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
                  No messages yet. Publish one here, then watch it appear in every open viewer.
                </div>
              ) : null}
              {messages.map((message) => {
                const mine = message.metadata.viewerId === viewerId;
                const messageUser =
                  typeof message.metadata.user === "string" ? message.metadata.user : "Unknown";
                return (
                  <article
                    key={message.id}
                    className={cn(
                      "rounded-lg border p-3",
                      mine ? "border-primary/40 bg-primary/5 ml-8" : "bg-muted/30 mr-8",
                    )}
                  >
                    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold">{messageUser}</span>
                      <Badge variant={mine ? "default" : "outline"}>{mine ? "you" : "other"}</Badge>
                      <Badge variant="secondary">{message.type}</Badge>
                      <time className="text-muted-foreground ml-auto">
                        {new Date(message.publishedAt).toLocaleTimeString()}
                      </time>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
                          Body
                        </div>
                        <pre className="bg-background/70 max-h-64 overflow-auto rounded-md border p-3 text-xs">
                          {jsonText(message.body)}
                        </pre>
                      </div>
                      <details>
                        <summary className="text-muted-foreground cursor-pointer text-xs font-medium uppercase tracking-wide">
                          Metadata ({Object.keys(message.metadata).length} keys)
                        </summary>
                        <pre className="bg-background/70 mt-2 max-h-72 overflow-auto rounded-md border p-3 text-xs">
                          {jsonText(message.metadata)}
                        </pre>
                      </details>
                    </div>
                  </article>
                );
              })}
              <div ref={endRef} />
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
};

export default Bus;
