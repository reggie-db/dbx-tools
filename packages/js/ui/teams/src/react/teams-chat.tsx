// A Teams-like chat surface for the `@dbx-tools/teams` conversation endpoint.
// Each turn POSTs a Bot Framework activity to `POST /api/teams/activity` and
// appends the activities the bot answers with; a reply's Adaptive Card
// attachments render through the `adaptivecards` renderer, so the transcript
// looks like a Teams channel where the agent always answers in cards.

import { hash, json, string } from "@dbx-tools/shared-core";
import { activity as sharedActivity, type Activity } from "@dbx-tools/shared-teams";
import { Avatar, AvatarFallback, Button, Input, Spinner, cn } from "@dbx-tools/ui-appkit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdaptiveCardView } from "./adaptive-card.tsx";

/** Props for {@link TeamsChat}. */
export interface TeamsChatProps {
  /**
   * Conversation endpoint. Defaults to the Bot Framework messaging endpoint
   * (`/api/teams/messages`) - the SAME route a real Teams channel calls, which
   * is why this surface is a faithful preview rather than a parallel
   * implementation.
   *
   * That route only answers in the HTTP response when the server enables its
   * development bypass (`allowUnauthenticated`); against a real bot
   * registration it validates a Bot Service JWT and delivers replies through
   * the Connector API, so this component cannot drive it. Point at
   * `/api/teams/activity` for a server that keeps `/messages` locked down.
   */
  endpoint?: string;
  /** Mastra agent to answer with. Defaults to the server's default agent. */
  agentId?: string;
  /** Display name of the local user, shown on their messages. */
  userName?: string;
  /** Prompts offered as one-tap starters while the transcript is empty. */
  starters?: string[];
  /** Extra classes merged onto the root container. */
  className?: string;
}

/**
 * Default starters. Deliberately generic - they exercise the different parts of
 * a card (facts, bullets, actions) without assuming what the agent is wired to.
 */
export const DEFAULT_STARTERS = [
  "Summarize today's deployment status",
  "What should I know about this workspace?",
  "Draft a release note for version 1.4.2",
];

/** The local user's identity on outbound activities. */
const localUser = (name: string) => ({ id: "local-user", name });

/** Whether an activity was authored by the local user rather than the bot. */
const isFromUser = (item: Activity): boolean => item.from?.id === "local-user";

/**
 * A Teams-style conversation with an agent that answers in Adaptive Cards.
 *
 * The transcript is a list of Bot Framework activities - the same objects the
 * endpoint exchanges - so what renders here is exactly what a real channel
 * would receive. A conversation id is minted once per mount and sent on every
 * turn, which is what threads the server's agent memory.
 */
export const TeamsChat = ({
  endpoint = "/api/teams/messages",
  agentId,
  userName = "You",
  starters = DEFAULT_STARTERS,
  className,
}: TeamsChatProps) => {
  const [transcript, setTranscript] = useState<Activity[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One conversation id for the lifetime of the mount: the server maps it onto
  // an agent memory thread, so reusing it is what makes the chat continuous.
  const conversationRef = useRef(`conv-${hash.id()}`);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks the in-flight turn so unmounting (or a rapid second send) cancels it
  // instead of resolving into a dead component.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the newest activity in view as the transcript grows.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript, pending]);

  const send = useCallback(
    async (text: string) => {
      const prompt = string.trimToNull(text);
      if (!prompt || pending) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const outbound: Activity = {
        type: "message",
        id: hash.id(),
        timestamp: new Date().toISOString(),
        text: prompt,
        from: localUser(userName),
        conversation: { id: conversationRef.current },
      };
      // Echo the user's turn immediately; the reply is appended when it lands.
      setTranscript((current) => [...current, outbound]);
      setDraft("");
      setError(null);
      setPending(true);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ activity: outbound, ...(agentId ? { agentId } : {}) }),
          signal: controller.signal,
        });
        const body = json.parseRecord(await response.text());
        if (!response.ok) {
          throw new Error(
            string.trimToNull(String(body?.error ?? "")) ?? `Request failed (${response.status})`,
          );
        }
        const parsed = sharedActivity.activityResponseSchema.safeParse(body);
        if (!parsed.success) throw new Error("The server returned an unexpected reply.");
        setTranscript((current) => [...current, ...parsed.data.activities]);
      } catch (err) {
        // An aborted turn is a deliberate cancel, not a failure to report.
        if ((err as Error)?.name === "AbortError") return;
        setError((err as Error).message);
      } finally {
        if (abortRef.current === controller) setPending(false);
      }
    },
    [agentId, endpoint, pending, userName],
  );

  return (
    <div className={cn("flex h-full flex-col overflow-hidden rounded-lg border", className)}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="text-sm font-semibold">Teams conversation</span>
        <span className="text-muted-foreground text-xs">
          answers arrive as Adaptive Cards from <code>{endpoint}</code>
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {transcript.length === 0 && (
          <div className="space-y-3 py-6 text-center">
            <p className="text-muted-foreground text-sm">
              Ask the agent something. It replies with an Adaptive Card, the way a Teams bot does.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {starters.map((starter) => (
                <Button
                  key={starter}
                  variant="outline"
                  size="sm"
                  onClick={() => void send(starter)}
                >
                  {starter}
                </Button>
              ))}
            </div>
          </div>
        )}

        {transcript.map((item, index) => (
          <ActivityBubble key={item.id ?? index} activity={item} userName={userName} />
        ))}

        {pending && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner className="size-4" />
            <span>The agent is composing a card…</span>
          </div>
        )}

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message the agent…"
          aria-label="Message the agent"
          disabled={pending}
        />
        <Button type="submit" disabled={pending || string.trimToNull(draft) === null}>
          Send
        </Button>
      </form>
    </div>
  );
};

/**
 * One activity in the transcript: the user's text on the right, the bot's reply
 * on the left with each Adaptive Card attachment rendered.
 */
const ActivityBubble = ({ activity, userName }: { activity: Activity; userName: string }) => {
  const fromUser = isFromUser(activity);
  const cards = sharedActivity.cardsOf(activity);
  const label = fromUser ? userName : (activity.from?.name ?? "Agent");

  return (
    <div className={cn("flex gap-3", fromUser && "flex-row-reverse")}>
      <Avatar className="size-8 shrink-0">
        <AvatarFallback className="text-xs">{initials(label)}</AvatarFallback>
      </Avatar>
      <div className={cn("min-w-0 max-w-[85%] space-y-2", fromUser && "items-end text-right")}>
        <span className="text-muted-foreground text-xs">{label}</span>
        {activity.text && (
          <div
            className={cn(
              "rounded-lg px-3 py-2 text-sm",
              fromUser ? "bg-primary text-primary-foreground" : "bg-muted",
            )}
          >
            {activity.text}
          </div>
        )}
        {cards.map((document, index) => (
          <div key={index} className="bg-card rounded-lg border p-3 text-left shadow-sm">
            <AdaptiveCardView card={document} />
          </div>
        ))}
      </div>
    </div>
  );
};

/** Up-to-two-letter initials for an avatar fallback. */
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
