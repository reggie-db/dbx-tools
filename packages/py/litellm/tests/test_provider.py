from __future__ import annotations

import pytest
from dbx_tools.litellm.provider import _ensure_json_mentioned

JSON_OBJECT = {"response_format": {"type": "json_object"}}


def _texts(messages: list[dict]) -> str:
    return " ".join(str(m.get("content", "")) for m in messages)


def test_untouched_when_json_object_not_requested() -> None:
    messages = [{"role": "user", "content": "hello"}]

    assert _ensure_json_mentioned(messages, {}) is messages


def test_untouched_when_a_message_already_mentions_json() -> None:
    # OpenAI's rule is satisfied by any casing, anywhere in the messages.
    messages = [{"role": "system", "content": "Reply as JSON."}, {"role": "user", "content": "hi"}]

    assert _ensure_json_mentioned(messages, JSON_OBJECT) is messages


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
