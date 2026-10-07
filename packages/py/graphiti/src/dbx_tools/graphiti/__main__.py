"""Run Graphiti or print its OpenAPI document."""

import json
import sys

import uvicorn

from .main import app, load_graphiti_options


def main(argv: list[str] | None = None) -> None:
    """Start the environment-configured server, or print OpenAPI for ``docs``."""
    arguments = sys.argv[1:] if argv is None else argv
    if arguments == ["docs"]:
        json.dump(app.openapi(), sys.stdout, separators=(",", ":"), sort_keys=True)
        sys.stdout.write("\n")
        return
    if arguments:
        raise SystemExit("usage: python -m dbx_tools.graphiti [docs]")
    listen = load_graphiti_options()["listen"]
    if listen["scheme"] != "tcp":
        raise SystemExit("Graphiti requires a TCP listener")
    uvicorn.run(app, host=listen["host"], port=int(listen["port"]))


if __name__ == "__main__":
    main()
