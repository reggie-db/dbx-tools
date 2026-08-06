from dbx_tools.postgres.topic_bus import (
    _CHANNEL_FALLBACK,
    _CHANNEL_HASH_LENGTH,
    _DEFAULT_CHANNEL,
    _MAX_CHANNEL_LENGTH,
    _MAX_NOTIFY_BYTES,
    _MAX_RECONNECT_DELAY,
    _MIN_RECONNECT_DELAY,
)

"""Expose private protocol constants through one test-only object."""

default_channel = _DEFAULT_CHANNEL
max_channel_length = _MAX_CHANNEL_LENGTH
channel_hash_length = _CHANNEL_HASH_LENGTH
channel_fallback = _CHANNEL_FALLBACK
max_notify_bytes = _MAX_NOTIFY_BYTES
min_reconnect_delay = _MIN_RECONNECT_DELAY
max_reconnect_delay = _MAX_RECONNECT_DELAY
