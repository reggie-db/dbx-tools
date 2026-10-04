from __future__ import annotations

from dbx_tools.node_bindings import browser


async def test_open_browser_uses_standard_library(monkeypatch) -> None:
    calls = []

    def open_url(url: str, *, new: int, autoraise: bool) -> bool:
        calls.append((url, new, autoraise))
        return True

    monkeypatch.setattr(browser.webbrowser, "open", open_url)

    await browser.open_browser("https://example.com/authorize")

    assert calls == [("https://example.com/authorize", 2, True)]
