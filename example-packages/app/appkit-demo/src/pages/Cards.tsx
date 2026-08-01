import { Tabs, TabsContent, TabsList, TabsTrigger } from "@dbx-tools/ui-appkit/react";
import { dedupeSuggestions, useMastraSuggestions } from "@dbx-tools/ui-mastra/react";
import { AdaptiveCardGallery, TeamsChat } from "@dbx-tools/ui-teams/react";

// Teams Adaptive Cards demo, two ways into the same `@dbx-tools/teams` plugin:
//
// - "Chat" is the simulated Teams conversation. Each turn POSTs a Bot Framework
//   activity to `/api/teams/activity` - the plugin's conversation endpoint, the
//   same idea as the Mastra plugin's `/mcp` - and the Mastra agent answers with
//   Adaptive Card attachments that render like a Teams channel.
// - "Card builder" is the lower-level preview: edit a `CardSpec`, compile it
//   through `/api/teams/card`, and see the document render.
//
// Both render with the `adaptivecards` JavaScript renderer, the same one Teams
// preview tools embed.

const Cards = () => {
  // Starter prompts come from the agent's Genie space via the Mastra plugin's
  // `/suggestions` route - the same source `MastraChat` uses on the Stream page,
  // run through the same dedupe + cap. That is what lets both pages open with
  // the same questions and answer them with the same numbers; only the
  // presentation (a card instead of streamed markdown) differs. Empty while the
  // lookup is in flight, or when the agent has no Genie space, which leaves the
  // empty state bare rather than showing prompts the agent cannot answer.
  const { questions } = useMastraSuggestions();

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-hidden p-4 md:p-6">
      <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="self-start">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="builder">Card builder</TabsTrigger>
        </TabsList>
        <TabsContent value="chat" className="min-h-0 flex-1">
          <TeamsChat className="h-full" starters={dedupeSuggestions(questions)} />
        </TabsContent>
        <TabsContent value="builder" className="min-h-0 flex-1 overflow-auto">
          <AdaptiveCardGallery />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Cards;
