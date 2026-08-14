from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated

from cyclopts import App, Parameter
from dbx_tools.core import bin

from .runtime import RuntimePaths

"""Caddy front proxy for an AppKit server and Graphiti sidecar."""

CADDY_MISE_TOOL = "caddy@2.10.2"


@dataclass
class ProxyOptions:
    """Caddy proxy ports and route configuration."""

    public_port: Annotated[
        int,
        Parameter(name="--public-port", env_var="DATABRICKS_APP_PORT"),
    ]
    app_port: Annotated[int, Parameter(name="--app-port", env_var="GRAPHITI_APP_PORT")]
    graphiti_port: Annotated[
        int,
        Parameter(name="--graphiti-port", env_var="GRAPHITI_PORT"),
    ]
    route_prefix: Annotated[
        str,
        Parameter(name="--route-prefix", env_var="GRAPHITI_ROUTE_PREFIX"),
    ] = "/graphiti"

    def __call__(self) -> None:
        config = caddy_config(
            public_port=self.public_port,
            app_port=self.app_port,
            graphiti_port=self.graphiti_port,
            route_prefix=self.route_prefix,
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
    public_port: int,
    app_port: int,
    graphiti_port: int,
    route_prefix: str,
) -> str:
    """Render the single-port Caddy routing configuration."""
    ports = (public_port, app_port, graphiti_port)
    if any(port <= 0 or port > 65535 for port in ports):
        raise ValueError("ports must be between 1 and 65535")
    if len(set(ports)) != len(ports):
        raise ValueError("public, AppKit, and Graphiti ports must be distinct")
    prefix = "/" + route_prefix.strip("/")
    return (
        "{\n"
        "  admin off\n"
        "  auto_https off\n"
        "}\n\n"
        f":{public_port} {{\n"
        f"  handle {prefix}/mcp/ {{\n"
        "    rewrite * /mcp\n"
        f"    reverse_proxy 127.0.0.1:{graphiti_port}\n"
        "  }\n"
        f"  handle_path {prefix}/* {{\n"
        f"    reverse_proxy 127.0.0.1:{graphiti_port}\n"
        "  }\n"
        "  handle {\n"
        f"    reverse_proxy 127.0.0.1:{app_port}\n"
        "  }\n"
        "}\n"
    )


if __name__ == "__main__":
    main()
