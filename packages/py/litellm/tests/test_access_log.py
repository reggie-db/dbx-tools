from __future__ import annotations

import logging
from typing import Any

import pytest
from dbx_tools.litellm.access_log import LOGGER_NAME, DbxAccessLogger, _format


def payload(**overrides: Any) -> dict[str, Any]:
    standard: dict[str, Any] = {
        "model": "databricks-gpt-5-5-pro",
        "call_type": "aresponses",
        "startTime": 100.0,
        "completionStartTime": 101.0,
        "endTime": 110.0,
        "stream": True,
        "prompt_tokens": 1000,
        "completion_tokens": 50,
        "hidden_params": {
            "usage_object": {
                "prompt_tokens_details": {"cached_tokens": 900},
                "completion_tokens_details": {"reasoning_tokens": 20},
            }
        },
    }
    standard.update(overrides)
    return {"standard_logging_object": standard}


def test_reports_latency_tokens_and_cache() -> None:
    line = _format(payload(), status="ok")

    assert "ttft=1.00s" in line
    assert "total=10.00s" in line
    assert "in=1000" in line
    assert "out=50" in line
    assert "cached=900(90%)" in line
    assert "reasoning=20" in line
    assert "tok/s=5.0" in line


def test_real_stream_is_not_flagged_as_emulated() -> None:
    assert "emulated=False" in _format(payload(), status="ok")


def test_emulated_stream_is_flagged() -> None:
    # A faked stream buffers the whole response, so first and last token coincide.
    line = _format(payload(completionStartTime=110.0), status="ok")

    assert "emulated=True" in line


def test_non_streaming_calls_omit_the_emulated_field() -> None:
    line = _format(payload(stream=False), status="ok")

    assert "stream=False" in line
    assert "emulated" not in line


def test_zero_cache_hits_are_reported_rather_than_hidden() -> None:
    # A 0% cache rate on a large prompt is the signal worth seeing, so it must
    # render rather than being dropped as falsy.
    usage = {"prompt_tokens_details": {"cached_tokens": 0}}
    line = _format(payload(hidden_params={"usage_object": usage}), status="ok")

    assert "cached=0(0%)" in line


def test_missing_timings_degrade_without_raising() -> None:
    line = _format({}, status="ok")

    assert "status=ok" in line
    assert "ttft" not in line


def test_errors_are_included() -> None:
    line = _format(payload(error_str="upstream exploded"), status="error")

    assert "status=error" in line
    assert "upstream exploded" in line


@pytest.mark.asyncio
async def test_success_and_failure_events_log_once() -> None:
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    # The logger deliberately stops propagation so its lines are not duplicated
    # by LiteLLM's root handler, so capture has to attach to it directly.
    handler = Capture()
    access_logger = logging.getLogger(LOGGER_NAME)
    access_logger.addHandler(handler)
    try:
        logger = DbxAccessLogger()
        await logger.async_log_success_event(payload(), None, None, None)
        await logger.async_log_failure_event(payload(), None, None, None)
    finally:
        access_logger.removeHandler(handler)

    assert len(records) == 2
    assert "status=ok" in records[0].getMessage()
    assert records[0].levelno == logging.INFO
    assert "status=error" in records[1].getMessage()
    assert records[1].levelno == logging.WARNING


def test_access_logger_does_not_propagate_to_root() -> None:
    # Propagating would double-print every line under the proxy's root handler.
    assert logging.getLogger(LOGGER_NAME).propagate is False
