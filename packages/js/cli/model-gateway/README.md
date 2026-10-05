# @dbx-tools/cli-model-gateway

Foreground and system-tray service commands for
`@dbx-tools/appkit-model-gateway`.

```sh
dbx model-gateway
dbx-model-gateway
```

Select a profile and loopback port explicitly when needed:

```sh
dbx model-gateway --profile PROFILE --port 4000
```

Install the default `127.0.0.1:4000` gateway as a current-user service:

```sh
dbx model-gateway service install --port 4401 --profile PROFILE
```

The port and profile are persisted in the installed service definition. The
service uses `@dbx-tools/cli-service` and `systray2`. It has no web window. Its
tray menu includes the program name and version, a `Models` item that opens the
configured port's `/v1/models` endpoint, and `Quit`.

Lifecycle commands:

```sh
dbx model-gateway service start
dbx model-gateway service stop
dbx model-gateway service restart
dbx model-gateway service status
dbx model-gateway service uninstall
```
