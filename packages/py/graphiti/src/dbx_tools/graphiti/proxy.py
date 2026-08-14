from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated

from cyclopts import App, Parameter
from dbx_tools.core import bin

from .runtime import RuntimePaths

"""Loopback Caddy proxy for the upstream Graphiti sidecar."""

CADDY_MISE_TOOL = "caddy@2.10.2"


@dataclass
class ProxyOptions:
    """Caddy proxy ports."""

    proxy_port: Annotated[
        int,
        Parameter(name="--proxy-port", env_var="PROXY_PORT"),
    ]
    graphiti_port: Annotated[
        int,
        Parameter(name="--graphiti-port", env_var="GRAPHITI_PORT"),
    ]

    def __call__(self) -> None:
        config = caddy_config(
            proxy_port=self.proxy_port,
            graphiti_port=self.graphiti_port,
        )
        path = RuntimePaths.default().root / "Caddyfile"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(config)
        caddy = bin.resolve("caddy", mise_tool=CADDY_MISE_TOOL)
        os.execv(caddy, [caddy, "run", "--config", str(path), "--adapter", "caddyfile"])


_APP = App(
    name="dbx-graphiti",
    default_command=ProxyOptions,
    result_action="call_if_callable",
)


def main(argv: Sequence[str] | None = None) -> None:
    """Install Caddy on demand and replace this process with the proxy."""
    _APP(argv)


def caddy_config(
    *,
    proxy_port: int,
    graphiti_port: int,
) -> str:
    """Render the internal Caddy routing configuration."""
    ports = (proxy_port, graphiti_port)
    if any(port <= 0 or port > 65535 for port in ports):
        raise ValueError("ports must be between 1 and 65535")
    if len(set(ports)) != len(ports):
        raise ValueError("proxy and Graphiti ports must be distinct")
    return (
        "{\n"
        "\tadmin off\n"
        "\tauto_https off\n"
        "}\n\n"
        f"http://127.0.0.1:{proxy_port} {{\n"
        f"\treverse_proxy 127.0.0.1:{graphiti_port}\n"
        "}\n"
    )


if __name__ == "__main__":
    main()
