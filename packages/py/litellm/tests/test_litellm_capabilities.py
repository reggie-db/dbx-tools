import json

import httpx
from dbx_tools.litellm.capabilities import AdaptiveTransport, UnsupportedParameterCache


def test_learns_and_applies_provider_rejections() -> None:
    cache = UnsupportedParameterCache(ttl_seconds=60)
    payload = {
        "model": "system.ai.qwen35-122b-a10b",
        "input": "hello",
        "parallel_tool_calls": True,
    }

    learned = cache.learn(
        "system.ai.qwen35-122b-a10b",
        {
            "error": {
                "message": 'Bad request: json: unknown field "parallel_tool_calls"',
            }
        },
        payload,
    )

    assert learned == "parallel_tool_calls"
    assert cache.parameters("system.ai.qwen35-122b-a10b") == {"parallel_tool_calls"}
    assert cache.apply("system.ai.qwen35-122b-a10b", payload) == {
        "model": "system.ai.qwen35-122b-a10b",
        "input": "hello",
    }


def test_learns_unsupported_reasoning_without_model_rules() -> None:
    cache = UnsupportedParameterCache(ttl_seconds=60)
    payload = {
        "model": "system.ai.llama-4-maverick",
        "input": "hello",
        "reasoning": {"effort": "medium"},
    }

    learned = cache.learn(
        "system.ai.llama-4-maverick",
        {
            "error": {
                "message": "This model does not support 'reasoning' for the Open Responses API.",
            }
        },
        payload,
    )

    assert learned == "reasoning"
    assert cache.apply("system.ai.llama-4-maverick", payload) == {
        "model": "system.ai.llama-4-maverick",
        "input": "hello",
    }


def test_learns_parameter_from_optional_article_wording() -> None:
    cache = UnsupportedParameterCache(ttl_seconds=60)
    payload = {
        "model": "system.ai.llama-4-maverick",
        "input": "hello",
        "parallel_tool_calls": True,
    }

    learned = cache.learn(
        "system.ai.llama-4-maverick",
        {
            "message": (
                "This model does not support the 'parallel_tool_calls' "
                "parameter for the Open Responses API."
            ),
        },
        payload,
    )

    assert learned == "parallel_tool_calls"


def test_cache_expires_learned_parameters() -> None:
    now = [0.0]
    cache = UnsupportedParameterCache(ttl_seconds=60, timer=lambda: now[0])
    payload = {"model": "model", "input": "hello", "optional": True}
    cache.learn(
        "model",
        {"message": 'json: unknown field "optional"'},
        payload,
    )

    now[0] = 61.0

    assert cache.parameters("model") == frozenset()
    assert cache.apply("model", payload) is payload


def test_does_not_strip_required_protocol_fields() -> None:
    cache = UnsupportedParameterCache(ttl_seconds=60)
    payload = {"model": "model", "input": "hello"}

    learned = cache.learn(
        "model",
        {"message": 'json: unknown field "input"'},
        payload,
    )

    assert learned is None
    assert cache.apply("model", payload) is payload


async def test_transport_retries_and_reuses_learned_capabilities() -> None:
    cache = UnsupportedParameterCache(ttl_seconds=60)
    attempts: list[dict[str, object]] = []

    async def send(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        attempts.append(payload)
        if "parallel_tool_calls" in payload:
            return httpx.Response(
                400,
                json={
                    "error_code": "BAD_REQUEST",
                    "message": 'Bad request: json: unknown field "parallel_tool_calls"',
                },
                request=request,
            )
        return httpx.Response(200, json={"status": "completed"}, request=request)

    transport = AdaptiveTransport(
        cache,
        transport=httpx.MockTransport(send),
    )
    async with httpx.AsyncClient(transport=transport) as client:
        for _ in range(2):
            response = await client.post(
                "https://workspace.example/responses",
                json={
                    "model": "system.ai.qwen35-122b-a10b",
                    "input": "hello",
                    "parallel_tool_calls": True,
                },
            )
            assert response.status_code == 200

    assert attempts == [
        {
            "model": "system.ai.qwen35-122b-a10b",
            "input": "hello",
            "parallel_tool_calls": True,
        },
        {
            "model": "system.ai.qwen35-122b-a10b",
            "input": "hello",
        },
        {
            "model": "system.ai.qwen35-122b-a10b",
            "input": "hello",
        },
    ]
