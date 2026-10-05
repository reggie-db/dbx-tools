from dbx_tools.postgres.topic_bus import (
    _DEFAULT_CHANNEL,
    _MAX_NOTIFY_BYTES,
    _MAX_RECONNECT_DELAY,
    _MIN_RECONNECT_DELAY,
)

"""Expose private protocol constants through one test-only object."""

default_channel = _DEFAULT_CHANNEL
max_notify_bytes = _MAX_NOTIFY_BYTES
min_reconnect_delay = _MIN_RECONNECT_DELAY
max_reconnect_delay = _MAX_RECONNECT_DELAY
