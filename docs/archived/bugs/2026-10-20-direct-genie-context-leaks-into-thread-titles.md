# Direct Genie context leaks into conversation titles

Date: 2026-10-20

Status: Resolved

## Problem

Direct Genie chat prepends the private application-context envelope to the
question sent to Genie. Genie generates the conversation title from that raw
content, so the title can begin with a truncated internal marker such as:

```text
<dbx-tools-genie-context> Use t
```

Message projection already calls `visibleGenieQuestion()` to remove the hidden
context from user-visible transcript messages. Conversation listing did not
apply an equivalent policy: `listGenieThreads()` forwarded
`conversation.title`, and `GenieChatClient.threads()` displayed it unchanged.

## Expected behavior

- Conversation titles never expose `<dbx-tools-genie-context>` or its contents.
- A new conversation immediately uses the visible first user question as its
  provisional title.
- A later Genie-generated title can replace that provisional title only when it
  does not contain hidden context.
- Reloading history does not reintroduce a polluted server title.
- Application context continues to reach Genie on every turn.

## Resolution

`@dbx-tools/appkit-mastra` now owns title sanitation beside
`visibleGenieQuestion()`:

- Normal Genie titles pass through unchanged.
- Complete context envelopes are stripped.
- Titles truncated inside the hidden envelope are omitted.
- Polluted titles recover from the first persisted conversation question, using
  the same visible-question projection as transcript history.
- A failed recovery leaves the title unset so the client keeps its provisional
  title or normal untitled fallback.

Application context still reaches Genie for execution and remains absent from
the transcript and thread title.

## Tests

- A normal Genie title passes through unchanged.
- A title containing a complete context envelope returns only the visible
  question.
- A title truncated inside the opening envelope is omitted.
- Thread listing recovers the first visible persisted question.
- The transcript and Genie execution still receive the expected visible
  question and application context.
