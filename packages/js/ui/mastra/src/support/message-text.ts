import type { UIMessage } from "ai";

/** Join visible message text without collapsing boundaries occupied by non-text parts. */
export function messageTextFromParts(parts: UIMessage["parts"]): string {
  let text = "";
  let separatedByNonText = false;

  for (const part of parts) {
    if (part.type !== "text") {
      if (text.length > 0) separatedByNonText = true;
      continue;
    }

    if (part.text.length === 0) continue;

    if (separatedByNonText && !/\s$/u.test(text) && !/^\s/u.test(part.text)) {
      text += "\n\n";
    }

    text += part.text;
    separatedByNonText = false;
  }

  return text;
}
