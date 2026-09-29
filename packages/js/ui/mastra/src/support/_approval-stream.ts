import { json } from "@dbx-tools/shared-core";
import type { ChunkType } from "@mastra/core/stream";

/** Native-shaped response used only for approval streams that start at tool-result. */
export type ApprovalStreamResponse = Response & {
  processDataStream: (options: {
    onChunk: (chunk: ChunkType) => void | Promise<void>;
  }) => Promise<void>;
};

/**
 * Attach the native `processDataStream` shape without the client-js chat-state
 * side channel, which rejects a resumed stream whose first event is the pending
 * tool result. Remove this when the installed client accepts that native shape.
 */
export function asApprovalStreamResponse(response: Response): ApprovalStreamResponse {
  const streamResponse = response as ApprovalStreamResponse;
  streamResponse.processDataStream = async ({ onChunk }) => {
    if (!response.body) throw new Error("No response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const data = frame.slice(6);
          if (data === "[DONE]") return;
          const chunk = json.parse<ChunkType>(data);
          if (!chunk) throw new TypeError("Mastra approval stream emitted invalid JSON");
          await onChunk(chunk);
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  return streamResponse;
}
