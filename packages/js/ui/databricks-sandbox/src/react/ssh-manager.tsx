import type {
  AddSshRouteRequest,
  SshMachine,
  SshMachineServiceKind,
  SshRoute,
} from "@dbx-tools/shared-databricks-sandbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
  cn,
} from "@dbx-tools/ui/react";
import {
  ExternalLinkIcon,
  HeartPulseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SshClient } from "./client.ts";
import { resolveServiceUrl } from "./service-url.ts";

/** Props for the full SSH machine and route management surface. */
export interface SshManagerProps {
  basePath?: string;
  defaultRemotePort?: number;
  className?: string;
}

/** Manages existing SSH machines and their registered AppKit proxy routes. */
export function SshManager({
  basePath = "/api/databricks-sandbox",
  defaultRemotePort = 3000,
  className,
}: SshManagerProps) {
  const client = useMemo(() => new SshClient(basePath), [basePath]);
  const [machines, setMachines] = useState<SshMachine[]>([]);
  const [routes, setRoutes] = useState<SshRoute[]>([]);
  const [supported, setSupported] = useState(true);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [machineId, setMachineId] = useState("");
  const [newMachineName, setNewMachineName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SshMachine>();
  const [remotePort, setRemotePort] = useState(String(defaultRemotePort));
  const [path, setPath] = useState("");
  const [stripPrefix, setStripPrefix] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [machineResponse, routeResponse] = await Promise.all([
        client.listMachines(),
        client.listRoutes(),
      ]);
      setSupported(machineResponse.supported);
      setAuto(machineResponse.auto);
      setMachines(machineResponse.machines);
      setRoutes(routeResponse);
      setMachineId((current) =>
        current && machineResponse.machines.some((machine) => machine.id === current)
          ? current
          : (machineResponse.machines[0]?.id ?? ""),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const manageMachine = async (machine: SshMachine, action: "start" | "stop") => {
    setBusyId(machine.id);
    setError(undefined);
    try {
      await client[action](machine.id);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const createMachine = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusyId("new-machine");
    setError(undefined);
    try {
      const created = await client.create(
        newMachineName.trim() ? { name: newMachineName.trim() } : {},
      );
      setNewMachineName("");
      setMachines((current) => [
        created,
        ...current.filter((machine) => machine.id !== created.id),
      ]);
      setMachineId(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const deleteMachine = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setError(undefined);
    try {
      await client.delete(deleteTarget.id);
      setDeleteTarget(undefined);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const addRoute = async (event: React.FormEvent) => {
    event.preventDefault();
    const port = Number(remotePort);
    if (!machineId || !Number.isInteger(port) || port < 1 || port > 65535) return;
    setBusyId("new-route");
    setError(undefined);
    const input: AddSshRouteRequest = {
      machineId,
      remotePort: port,
      stripPrefix,
      ...(path.trim() ? { path: path.trim() } : {}),
    };
    try {
      await client.addRoute(input);
      setPath("");
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const openService = async (machine: SshMachine, service: SshMachineServiceKind) => {
    setBusyId(`${machine.id}:${service}`);
    setError(undefined);
    try {
      const result = await client.startService(machine.id, service);
      window.open(resolveServiceUrl(result.path), "_blank", "noopener,noreferrer");
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const removeRoute = async (route: SshRoute) => {
    setBusyId(route.id);
    setError(undefined);
    try {
      await client.removeRoute(route.id);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{machines.length} machines</span>
          <span aria-hidden="true">·</span>
          <span>{routes.length} routes</span>
          <Badge variant="outline">auto {auto ? "on" : "off"}</Badge>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={refresh}>
          {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
          Refresh
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      {!supported && !loading ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            SSH machines are not available in this workspace.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
          <Card>
            <CardHeader className="px-4 py-3 sm:px-5">
              <CardTitle className="text-base">Machines</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {machines.length === 0 && !loading ? (
                <p className="px-4 pb-4 text-sm text-muted-foreground">No existing machines.</p>
              ) : (
                <div className="divide-y">
                  {machines.map((machine) => (
                    <div
                      key={machine.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:px-5"
                    >
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full",
                          statusColor(machine.status),
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{machine.name}</span>
                          <Badge variant="secondary">{machine.status}</Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {machine.id} · {machine.routes.length} routes
                        </p>
                      </div>
                      <div className="flex w-full shrink-0 items-center justify-end gap-1 overflow-x-auto sm:w-auto sm:overflow-visible">
                        {busyId === machine.id ? <Spinner className="mr-1 size-4" /> : null}
                        {machine.canStart ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 px-2 sm:px-3"
                            aria-label={`Start ${machine.name}`}
                            title="Start"
                            disabled={Boolean(busyId)}
                            onClick={() => void manageMachine(machine, "start")}
                          >
                            <PlayIcon className="size-3.5" />
                            <span className="hidden sm:inline">Start</span>
                          </Button>
                        ) : null}
                        {machine.canStop ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 px-2 sm:px-3"
                            aria-label={`Stop ${machine.name}`}
                            title="Stop"
                            disabled={Boolean(busyId)}
                            onClick={() => void manageMachine(machine, "stop")}
                          >
                            <SquareIcon className="size-3.5" />
                            <span className="hidden sm:inline">Stop</span>
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 px-2 sm:px-3"
                          aria-label={`Open terminal for ${machine.name}`}
                          title="Terminal"
                          disabled={Boolean(busyId)}
                          onClick={() => void openService(machine, "terminal")}
                        >
                          {busyId === `${machine.id}:terminal` ? (
                            <Spinner className="size-3.5" />
                          ) : (
                            <SquareTerminalIcon className="size-3.5" />
                          )}
                          <span className="hidden sm:inline">Terminal</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 px-2 sm:px-3"
                          aria-label={`Open stats for ${machine.name}`}
                          title="Stats"
                          disabled={Boolean(busyId)}
                          onClick={() => void openService(machine, "stats")}
                        >
                          {busyId === `${machine.id}:stats` ? (
                            <Spinner className="size-3.5" />
                          ) : (
                            <HeartPulseIcon className="size-3.5" />
                          )}
                          <span className="hidden sm:inline">Stats</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0 px-2 text-destructive hover:text-destructive sm:px-3"
                          aria-label={`Delete ${machine.name}`}
                          title="Delete"
                          disabled={Boolean(busyId)}
                          onClick={() => setDeleteTarget(machine)}
                        >
                          <Trash2Icon className="size-3.5" />
                          <span className="hidden sm:inline">Delete</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-3">
            <Card>
              <CardHeader className="px-4 pb-2 pt-3">
                <CardTitle className="text-base">Create sandbox</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <form className="flex items-center gap-2" onSubmit={createMachine}>
                  <div className="min-w-0 flex-1">
                    <Label className="sr-only" htmlFor="sandbox-name">
                      Name
                    </Label>
                    <Input
                      id="sandbox-name"
                      value={newMachineName}
                      maxLength={256}
                      placeholder="Optional"
                      disabled={Boolean(busyId)}
                      onChange={(event) => setNewMachineName(event.target.value)}
                    />
                  </div>
                  <Button className="shrink-0" type="submit" disabled={Boolean(busyId)}>
                    {busyId === "new-machine" ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <PlusIcon className="size-3.5" />
                    )}
                    Create
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Add route</CardTitle>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={addRoute}>
                  <div className="space-y-2">
                    <Label htmlFor="ssh-machine">Machine</Label>
                    <select
                      id="ssh-machine"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      value={machineId}
                      disabled={machines.length === 0 || Boolean(busyId)}
                      onChange={(event) => setMachineId(event.target.value)}
                    >
                      {machines.map((machine) => (
                        <option key={machine.id} value={machine.id}>
                          {machine.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-[1fr_8rem] gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="ssh-path">Path</Label>
                      <Input
                        id="ssh-path"
                        value={path}
                        placeholder="Auto"
                        disabled={Boolean(busyId)}
                        onChange={(event) => setPath(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ssh-port">Remote port</Label>
                      <Input
                        id="ssh-port"
                        type="number"
                        min={1}
                        max={65535}
                        value={remotePort}
                        disabled={Boolean(busyId)}
                        onChange={(event) => setRemotePort(event.target.value)}
                      />
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={stripPrefix}
                      disabled={Boolean(busyId)}
                      onChange={(event) => setStripPrefix(event.target.checked)}
                    />
                    <span>
                      <span className="block font-medium">Strip route prefix</span>
                      <span className="block text-xs text-muted-foreground">
                        Forward the path after the registered route, matching the Caddy proxy
                        default.
                      </span>
                    </span>
                  </label>
                  <Button type="submit" disabled={!machineId || Boolean(busyId)}>
                    {busyId === "new-route" ? (
                      <Spinner className="size-4" />
                    ) : (
                      <PlusIcon className="size-4" />
                    )}
                    Add route
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {routes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Registered routes</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {routes.map((route) => (
                <div key={route.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <a
                      className="inline-flex max-w-full items-center gap-1.5 truncate text-sm font-medium text-primary hover:underline"
                      href={route.path}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="truncate">{route.path}</span>
                      <ExternalLinkIcon className="size-3.5 shrink-0" />
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {machineName(machines, route.machineId)} · {route.remoteHost}:
                      {route.remotePort} · prefix {route.stripPrefix ? "stripped" : "preserved"}
                    </p>
                  </div>
                  <Badge variant={route.state === "ready" ? "secondary" : "outline"}>
                    {route.state}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${route.path}`}
                    disabled={Boolean(busyId)}
                    onClick={() => void removeRoute(route)}
                  >
                    {busyId === route.id ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Trash2Icon className="size-4" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !busyId) setDeleteTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this sandbox?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${deleteTarget.name} and its persistent files will be permanently deleted.`
                : "This sandbox and its persistent files will be permanently deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busyId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void deleteMachine();
              }}
            >
              {deleteTarget && busyId === deleteTarget.id ? (
                <Spinner className="size-3.5" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Delete sandbox
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function machineName(machines: SshMachine[], machineId: string): string {
  return machines.find((machine) => machine.id === machineId)?.name ?? machineId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusColor(status: SshMachine["status"]): string {
  if (status === "running") return "bg-emerald-500";
  if (status === "starting" || status === "stopping") return "bg-amber-500";
  if (status === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
}
