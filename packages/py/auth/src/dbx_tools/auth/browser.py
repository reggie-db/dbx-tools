from __future__ import annotations

import asyncio
import webbrowser


async def open_browser(url: str) -> None:
    opened = await asyncio.to_thread(webbrowser.open, url, new=2, autoraise=True)
    if not opened:
        raise RuntimeError(f"Could not open browser for {url}")
