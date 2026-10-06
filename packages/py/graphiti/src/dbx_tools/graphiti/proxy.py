"""Run a loopback Caddy proxy for the upstream Graphiti sidecar."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence

from dbx_tools.core import bin

from .runtime import RuntimePaths

CADDY_MISE_TOOL = "caddy@2.10.2"


def main(argv: Sequence[str] | None = None) -> None:
    """Install Caddy on demand and replace this process with the proxy."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--proxy-port", type=int, default=os.getenv("PROXY_PORT"), required=True)
    parser.add_argument(
        "--graphiti-port",
        type=int,
        default=os.getenv("GRAPHITI_PORT"),
        required=True,
    )
    options = parser.parse_args(argv)
    config = caddy_config(
        proxy_port=options.proxy_port,
        graphiti_port=options.graphiti_port,
    )
    path = RuntimePaths.default().root / "Caddyfile"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(config)
    caddy = bin.resolve("caddy", mise_tool=CADDY_MISE_TOOL)
    os.execv(caddy, [caddy, "run", "--config", str(path), "--adapter", "caddyfile"])


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
