from __future__ import annotations

import pytest
from dbx_tools.litellm.provider import (
    _ensure_json_mentioned,
    _prepare_messages,
    _repair_trailing_assistant,
)

JSON_OBJECT = {"response_format": {"type": "json_object"}}


def _texts(messages: list[dict]) -> str:
    return " ".join(str(m.get("content", "")) for m in messages)


def test_untouched_when_json_object_not_requested() -> None:
    messages = [{"role": "user", "content": "hello"}]

    assert _ensure_json_mentioned(messages, {}) is messages


def test_untouched_when_a_non_system_message_already_mentions_json() -> None:
    # Any casing counts, as long as it is not a system message.
    messages = [{"role": "system", "content": "Extract."}, {"role": "user", "content": "as JSON"}]

    assert _ensure_json_mentioned(messages, JSON_OBJECT) is messages


def test_json_in_a_system_message_does_not_count() -> None:
    # This is the Mem0 case. Its extraction system prompt says "Return ONLY valid
    # JSON parsable by json.loads()", but the chat->Responses bridge hoists system
    # content into `instructions`, which Databricks does not scan — so a system
    # mention must NOT be treated as satisfying the rule.
    messages = [
        {"role": "system", "content": "Return ONLY valid JSON parsable by json.loads()."},
        {"role": "user", "content": "my name is Reggie"},
    ]

    patched = _ensure_json_mentioned(messages, JSON_OBJECT)

    assert patched is not messages
    assert "json" in patched[1]["content"].lower()
    assert patched[0]["content"] == "Return ONLY valid JSON parsable by json.loads()."


def test_nudge_lands_on_the_user_turn_not_the_system_message() -> None:
    # It MUST NOT go on the system message: the chat->Responses bridge hoists
    # system content into `instructions`, which Databricks does not scan for the
    # word "json", so the request would still be rejected on that path.
    messages = [
        {"role": "system", "content": "Extract facts."},
        {"role": "user", "content": "hi there"},
    ]

    patched = _ensure_json_mentioned(messages, JSON_OBJECT)

    assert patched[0] == {"role": "system", "content": "Extract facts."}
    assert "json" in patched[1]["content"].lower()
    assert patched[1]["content"].startswith("hi there")
    # The caller's list/dicts are not mutated in place.
    assert messages[1]["content"] == "hi there"


def test_nudge_appends_to_the_last_non_system_message() -> None:
    messages = [{"role": "user", "content": "first"}, {"role": "user", "content": "second"}]

    patched = _ensure_json_mentioned(messages, JSON_OBJECT)

    assert patched[0] == {"role": "user", "content": "first"}
    assert "json" in patched[1]["content"].lower()


def test_user_turn_is_added_for_a_system_only_request() -> None:
    messages = [{"role": "system", "content": "Extract facts."}]

    patched = _ensure_json_mentioned(messages, JSON_OBJECT)

    assert patched[0] == {"role": "system", "content": "Extract facts."}
    assert patched[-1]["role"] == "user"
    assert "json" in patched[-1]["content"].lower()


def test_multipart_content_is_searched_for_json() -> None:
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "return json please"}]},
    ]

    assert _ensure_json_mentioned(messages, JSON_OBJECT) is messages


def test_multipart_user_content_gets_an_extra_text_part() -> None:
    # Existing content blocks are preserved; the nudge is a new part.
    messages = [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]

    patched = _ensure_json_mentioned(messages, JSON_OBJECT)

    assert patched[0]["content"][0] == {"type": "text", "text": "hi"}
    assert "json" in patched[0]["content"][-1]["text"].lower()
    assert messages[0]["content"] == [{"type": "text", "text": "hi"}]


@pytest.mark.parametrize("response_format", [None, "json_object", {"type": "text"}, {}])
def test_other_response_formats_are_left_alone(response_format: object) -> None:
    messages = [{"role": "user", "content": "hi"}]

    assert _ensure_json_mentioned(messages, {"response_format": response_format}) is messages


class TestRepairTrailingAssistant:
    """Databricks rejects a transcript ending in an assistant message with "This
    model does not support assistant message prefill". Codex hits it on retry."""

    def test_untouched_when_ending_with_a_user_message(self) -> None:
        messages = [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "go"}]

        assert _repair_trailing_assistant(messages) is messages

    def test_trailing_assistant_message_is_dropped(self) -> None:
        messages = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "Hello"}]

        assert _repair_trailing_assistant(messages) == [{"role": "user", "content": "hi"}]

    def test_several_trailing_assistant_messages_are_dropped(self) -> None:
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "one"},
            {"role": "assistant", "content": "two"},
        ]

        assert _repair_trailing_assistant(messages) == [{"role": "user", "content": "hi"}]

    def test_trailing_tool_call_is_dropped(self) -> None:
        # LiteLLM may drop a Responses-only tool definition while leaving its
        # replayed assistant tool-call message behind. Claude then rejects that
        # terminal assistant turn as unsupported prefill.
        tool_turn = {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "1", "type": "function", "function": {"name": "t"}}],
        }
        messages = [{"role": "user", "content": "hi"}, tool_turn]

        assert _repair_trailing_assistant(messages) == [{"role": "user", "content": "hi"}]

    def test_all_assistant_transcript_is_not_emptied(self) -> None:
        # Not rescuable here; leave it for the provider to reject on its own terms
        # rather than sending an empty request.
        messages = [{"role": "assistant", "content": "one"}]

        assert _repair_trailing_assistant(messages) is messages

    def test_empty_messages_are_untouched(self) -> None:
        messages: list[dict] = []

        assert _repair_trailing_assistant(messages) is messages

    def test_the_caller_list_is_not_mutated(self) -> None:
        messages = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "Hello"}]

        _repair_trailing_assistant(messages)

        assert len(messages) == 2


class TestPrepareMessages:
    def test_repair_runs_before_the_json_nudge(self) -> None:
        # Order matters: nudging first would append to the assistant turn that the
        # repair then drops, losing the nudge and re-failing the json rule.
        messages = [
            {"role": "system", "content": "Return ONLY valid JSON."},
            {"role": "user", "content": "extract"},
            {"role": "assistant", "content": "partial answer"},
        ]

        prepared = _prepare_messages(messages, JSON_OBJECT)

        assert prepared[-1]["role"] == "user"
        assert "json" in prepared[-1]["content"].lower()
        assert prepared[-1]["content"].startswith("extract")

    def test_no_op_request_is_passed_through(self) -> None:
        messages = [{"role": "user", "content": "hi"}]

        assert _prepare_messages(messages, {}) is messages


class TestPydanticMessageObjects:
    """LiteLLM's Responses->Chat bridge passes `litellm.types.utils.Message`, a
    pydantic model that is NOT a Mapping. An isinstance(..., Mapping) guard skips
    exactly these objects, which is the Codex path — so every repair must read
    fields through _field instead."""

    @staticmethod
    def _message(**kwargs):
        from litellm.types.utils import Message

        return Message(**kwargs)

    def test_message_object_is_not_a_mapping(self) -> None:
        from collections.abc import Mapping

        # Guards the assumption this whole class exists to protect.
        assert not isinstance(self._message(role="assistant", content="x"), Mapping)

    def test_trailing_assistant_message_object_is_dropped(self) -> None:
        messages = [{"role": "user", "content": "hi"}, self._message(role="assistant", content="x")]

        assert _repair_trailing_assistant(messages) == [{"role": "user", "content": "hi"}]

    def test_trailing_message_object_with_tool_calls_is_dropped(self) -> None:
        tool_turn = self._message(
            role="assistant",
            content="",
            tool_calls=[
                {"id": "1", "type": "function", "function": {"name": "t", "arguments": "{}"}}
            ],
        )
        messages = [{"role": "user", "content": "hi"}, tool_turn]

        assert _repair_trailing_assistant(messages) == [{"role": "user", "content": "hi"}]

    def test_json_in_a_message_object_counts_as_mentioned(self) -> None:
        messages = [self._message(role="user", content="reply in json")]

        assert _ensure_json_mentioned(messages, JSON_OBJECT) is messages

    def test_nudge_applies_to_a_message_object(self) -> None:
        messages = [
            {"role": "system", "content": "Return ONLY valid JSON."},
            self._message(role="user", content="extract"),
        ]

        prepared = _prepare_messages(messages, JSON_OBJECT)

        assert prepared[-1]["role"] == "user"
        assert "json" in str(prepared[-1]["content"]).lower()
