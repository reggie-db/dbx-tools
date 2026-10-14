---
name: network-speed-test
description: Run LibreSpeed as a Lakebox service to measure browser-to-AppKit-to-Lakebox HTTP throughput.
---

# Network Speed Test

Call `create_lakebox_service` once:

```json
{
  "name": "speed-test",
  "image": "docker.io/library/alpine:3.22",
  "mounts": [{ "source": "speed-test", "target": "/app" }],
  "command": [
    "sh",
    "-c",
    "set -eu; cd /app; arch=$(uname -m); case \"$arch\" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac; [ -x speedtest-backend ] || wget -qO- \"https://github.com/librespeed/speedtest-go/releases/download/v1.1.6/speedtest-go_1.1.6_linux_${arch}.tar.gz\" | tar -xz; printf 'bind_address = \"127.0.0.1\"\\nlisten_port = %s\\nserver_lat = 1\\nserver_lng = 1\\ndatabase_type = \"none\"\\n' \"$SERVICE_PORT\" > settings.toml; exec ./speedtest-backend"
  ]
}
```

Do not call public speed-test services or external CDNs. The result measures
browser-to-AppKit-to-Lakebox traffic, including proxy and SSH forwarding
overhead; it is not an ISP or raw workspace network test. Return the service
`openUrl` as a Markdown link.
