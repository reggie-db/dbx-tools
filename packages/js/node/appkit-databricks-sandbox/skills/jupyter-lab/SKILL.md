---
name: jupyter-lab
description: Launch a prefix-aware JupyterLab workspace through an authenticated route on an assigned Databricks Sandbox.
---

# JupyterLab

Use an assigned machine and inspect the available Python environment first.
Prefer an existing JupyterLab installation. If installation is needed, use a
user-owned virtual environment under `~/.dbx-tools/runtime/jupyter/`, the
machine's configured package registry, and obtain confirmation before adding
packages.

Reserve the route with `add_ssh_route` using the suffix `/lab` and
`stripPrefix: false`, then configure JupyterLab with the exact returned path as
its `ServerApp.base_url`. Bind to `127.0.0.1`, disable automatic browser launch,
keep runtime files and logs under `~/.dbx-tools/runtime/jupyter/`, and return
the registered path after the server responds successfully.

For a seamless demo, Jupyter's own token may be disabled only while all of the
following remain true: the listener is loopback-only, the route is the
owner-scoped AppKit route, and no alternate direct port is exposed. Otherwise
retain Jupyter authentication and never place credentials in a shared URL.

JupyterLab uses WebSockets for kernels and terminals. `stripPrefix: false` and
the matching `base_url` are required so HTTP assets, API calls, and socket paths
all retain the registered user-prefixed route. If extensions emit root-
absolute paths that ignore `base_url`, report the limitation rather than
adding an unauthenticated alias.
