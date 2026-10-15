---
name: jupyter-lab
description: Deploy or run JupyterLab as a Lakebox service behind the user's authenticated route, without a separate Jupyter password or token. Use for notebook app or notebook service requests.
---

# JupyterLab

Use the pinned Docker/OCI image through `create_lakebox_service`. Do not run a
container CLI directly.

Call `create_lakebox_service` once:

```json
{
  "name": "jupyter-lab",
  "image": "docker.io/library/python:3.12-slim",
  "mounts": [{ "source": "notebooks", "target": "/work" }],
  "stripPrefix": false,
  "openPath": "lab",
  "command": [
    "sh",
    "-c",
    "[ -x /work/.venv/bin/jupyter ] || { python -m venv /work/.venv && /work/.venv/bin/pip install --quiet jupyterlab==4.4.10; } && exec /work/.venv/bin/jupyter lab --allow-root --no-browser --ip 127.0.0.1 --port \"$SERVICE_PORT\" --ServerApp.root_dir=/work --ServerApp.base_url=\"$SERVICE_PATH\" --IdentityProvider.token= --PasswordIdentityProvider.hashed_password="
  ]
}
```

The AppKit route supplies authentication, so do not add another token or
password. Jupyter serves its full route path, so `stripPrefix` is false.
Notebooks and the virtual environment persist in `~/notebooks`, so later starts
skip installation. The first start installs JupyterLab and can take a minute.
Return the service `openUrl` as a Markdown link.
