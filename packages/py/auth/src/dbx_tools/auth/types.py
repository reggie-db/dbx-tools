from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Protocol, TypedDict


class Token(TypedDict, total=False):
    accessToken: str
    tokenType: str
    refreshToken: str
    expiry: str
    scopes: list[str]


class AccessToken(TypedDict, total=False):
    accessToken: str
    tokenType: str
    expiry: str
    scopes: list[str]


@dataclass(frozen=True, slots=True)
class AuthOptions:
    refresh_buffer_seconds: int = 300
    lock_timeout_seconds: int = 30
    login_timeout_seconds: int = 900

    def to_javascript(self) -> dict[str, int]:
        return {
            "refreshBufferSeconds": self.refresh_buffer_seconds,
            "lockTimeoutSeconds": self.lock_timeout_seconds,
            "loginTimeoutSeconds": self.login_timeout_seconds,
        }


class TokenProvider(Protocol):
    def authenticate(self, timeout_ms: int) -> Awaitable[Token]: ...

    def login(self, timeout_ms: int) -> Awaitable[Token]: ...

    def refresh(self, token: Token) -> Awaitable[Token]: ...

    def can_authenticate_silently(self) -> bool: ...


class CredentialStore(Protocol):
    def load(self, key: str) -> Awaitable[Token | None]: ...

    def prepare_write(self) -> Awaitable[None]: ...

    def save(self, key: str, token: Token) -> Awaitable[None]: ...

    def remove(self, key: str) -> Awaitable[None]: ...

    def acquire_lock(self, key: str, timeout_ms: int) -> Awaitable[str]: ...

    def release_lock(self, lease: str) -> Awaitable[None]: ...

    def name(self) -> str: ...
