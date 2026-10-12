import type {
  AddSshProjectRequest,
  SshMachine,
  SshMachineServiceKind,
  SshProject,
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
  MonitorIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SshClient } from "./client.ts";
import { resolveServiceUrl } from "./service-url.ts";

const REFRESH_INTERVAL_MS = 5_000;

/** Props for the full SSH machine and project management surface. */
export interface SshManagerProps {
  basePath?: string;
  className?: string;
}

/** Manages existing SSH machines and their persisted Sandbox projects. */
export function SshManager({ basePath = "/api/databricks-sandbox", className }: SshManagerProps) {
  const client = useMemo(() => new SshClient(basePath), [basePath]);
  const [machines, setMachines] = useState<SshMachine[]>([]);
  const [projects, setProjects] = useState<SshProject[]>([]);
  const [projectPathPrefix, setProjectPathPrefix] = useState("/sandbox");
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [machineId, setMachineId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SshMachine>();
  const [resetTarget, setResetTarget] = useState<SshProject>();
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [port, setPort] = useState("");
  const [path, setPath] = useState("");
  const [openPath, setOpenPath] = useState("");
  const [stripPrefix, setStripPrefix] = useState(true);
  const refreshing = useRef(false);

  const refresh = useCallback(
    async (showLoading = false) => {
      if (refreshing.current) return;
      refreshing.current = true;
      if (showLoading) setLoading(true);
      setError(undefined);
      try {
        const [machineResponse, projectResponse] = await Promise.all([
          client.listMachines(),
          client.listProjects(),
        ]);
        setSupported(machineResponse.supported);
        setMachines(machineResponse.machines);
        setProjects(projectResponse.projects);
        setProjectPathPrefix(projectResponse.pathPrefix);
        setMachineId((current) =>
          current && machineResponse.machines.some((machine) => machine.id === current)
            ? current
            : (machineResponse.machines[0]?.id ?? ""),
        );
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        refreshing.current = false;
        if (showLoading) setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh(true);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(refreshVisible, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
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

  const createMachine = async () => {
    setBusyId("new-machine");
    setError(undefined);
    try {
      const created = await client.create();
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

  const addProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = projectName.trim().toLowerCase();
    const requestedPort = port.trim() ? Number(port) : undefined;
    if (!machineId || (name && !/^[a-z0-9][a-z0-9._-]*$/.test(name))) {
      return;
    }
    if (
      requestedPort !== undefined &&
      (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535)
    ) {
      return;
    }
    setBusyId("new-project");
    setError(undefined);
    const suffix = path.trim().replace(/^\/+|\/+$/g, "");
    const entry = openPath.trim();
    const input: AddSshProjectRequest = {
      machineId,
      stripPrefix,
      ...(name ? { name } : {}),
      ...(requestedPort !== undefined ? { port: requestedPort } : {}),
      ...(suffix ? { path: suffix } : {}),
      ...(entry ? { openPath: entry } : {}),
    };
    try {
      await client.addProject(input);
      setProjectName("");
      setPort("");
      setPath("");
      setOpenPath("");
      setProjectFormOpen(false);
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
      window.open(resolveServiceUrl(result.openUrl), "_blank", "noopener,noreferrer");
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const openProjectTerminal = async (project: SshProject) => {
    setBusyId(`${project.id}:terminal`);
    setError(undefined);
    try {
      const result = await client.openProjectTerminal(project.id);
      window.open(resolveServiceUrl(result.service.openUrl), "_blank", "noopener,noreferrer");
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const resetProject = async () => {
    if (!resetTarget) return;
    setBusyId(`${resetTarget.id}:reset`);
    setError(undefined);
    try {
      await client.resetProject(resetTarget.id);
      setResetTarget(undefined);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  const removeProject = async (project: SshProject) => {
    setBusyId(project.id);
    setError(undefined);
    try {
      await client.removeProject(project.id);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
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
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <Card className="gap-0 py-0">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 px-3 py-2.5 sm:px-4">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">Machines</CardTitle>
                <Badge variant="secondary">{machines.length}</Badge>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={Boolean(busyId)}
                onClick={() => void createMachine()}
              >
                {busyId === "new-machine" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
                Create
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {machines.length === 0 ? (
                <div className="flex min-h-16 items-center justify-center gap-2 border-t px-4 py-4 text-sm text-muted-foreground">
                  {loading ? <Spinner className="size-4" /> : null}
                  <span>{loading ? "Loading sandboxes" : "No sandboxes yet"}</span>
                </div>
              ) : (
                <div className="divide-y border-t">
                  {machines.map((machine) => (
                    <div
                      key={machine.id}
                      className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2 sm:flex-nowrap sm:px-4"
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
                          {machine.id} · expires {formatExpiration(machine.expiresAt)} ·{" "}
                          {machine.projects.length} projects
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
                          aria-label={`Open desktop for ${machine.name}`}
                          title="Desktop"
                          disabled={Boolean(busyId)}
                          onClick={() => void openService(machine, "desktop")}
                        >
                          {busyId === `${machine.id}:desktop` ? (
                            <Spinner className="size-3.5" />
                          ) : (
                            <MonitorIcon className="size-3.5" />
                          )}
                          <span className="hidden sm:inline">Desktop</span>
                        </Button>
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

          <Card className="gap-0 py-0">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 px-3 py-2 sm:px-4">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">Projects</CardTitle>
                <Badge variant="secondary">{projects.length}</Badge>
              </div>
              <Button
                type="button"
                variant={projectFormOpen ? "ghost" : "outline"}
                size="sm"
                className="h-8"
                aria-expanded={projectFormOpen}
                aria-controls="ssh-project-form"
                disabled={machines.length === 0 || Boolean(busyId)}
                onClick={() => setProjectFormOpen((open) => !open)}
              >
                <PlusIcon className="size-3.5" />
                {projectFormOpen ? "Cancel" : "Add project"}
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {projectFormOpen ? (
                <form
                  id="ssh-project-form"
                  className="space-y-2.5 border-t px-3 py-2.5 sm:px-4"
                  onSubmit={addProject}
                >
                  <div className="space-y-1.5">
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
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-project-name">Project name</Label>
                      <Input
                        id="ssh-project-name"
                        value={projectName}
                        placeholder="Auto"
                        disabled={Boolean(busyId)}
                        onChange={(event) => setProjectName(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-project-open-path">Open path</Label>
                      <Input
                        id="ssh-project-open-path"
                        value={openPath}
                        placeholder="open.html"
                        disabled={Boolean(busyId)}
                        onChange={(event) => setOpenPath(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-path">Path suffix</Label>
                      <div className="flex h-9 min-w-0 items-center rounded-md border border-input bg-transparent focus-within:ring-1 focus-within:ring-ring">
                        <span
                          className="max-w-[55%] shrink-0 truncate border-r px-2 font-mono text-xs text-muted-foreground"
                          title={projectPathPrefix}
                        >
                          {projectPathPrefix}/
                        </span>
                        <Input
                          id="ssh-path"
                          className="h-8 min-w-0 rounded-none border-0 px-2 shadow-none focus-visible:ring-0"
                          value={path}
                          placeholder="Auto"
                          disabled={Boolean(busyId)}
                          onChange={(event) => setPath(event.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-port">Port</Label>
                      <Input
                        id="ssh-port"
                        type="number"
                        min={1}
                        max={65535}
                        value={port}
                        placeholder="Auto"
                        disabled={Boolean(busyId)}
                        onChange={(event) => setPort(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={stripPrefix}
                        disabled={Boolean(busyId)}
                        onChange={(event) => setStripPrefix(event.target.checked)}
                      />
                      <span>Strip prefix</span>
                    </label>
                    <Button type="submit" size="sm" disabled={!machineId || Boolean(busyId)}>
                      {busyId === "new-project" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <PlusIcon className="size-3.5" />
                      )}
                      Add project
                    </Button>
                  </div>
                </form>
              ) : null}
              {projects.length === 0 ? (
                <div className="flex min-h-16 items-center justify-center border-t px-4 py-4 text-sm text-muted-foreground">
                  No projects yet
                </div>
              ) : (
                <div className="divide-y border-t">
                  {projects.map((project) => (
                    <div key={project.id} className="px-3 py-3 sm:px-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium">{project.name}</p>
                          <Badge variant={project.state === "ready" ? "secondary" : "outline"}>
                            {project.state}
                          </Badge>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button type="button" variant="outline" size="sm" asChild>
                            <a href={project.openUrl} target="_blank" rel="noopener noreferrer">
                              <ExternalLinkIcon className="size-3.5" />
                              Open
                            </a>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Open terminal for ${project.name}`}
                            disabled={Boolean(busyId)}
                            onClick={() => void openProjectTerminal(project)}
                          >
                            {busyId === `${project.id}:terminal` ? (
                              <Spinner className="size-3.5" />
                            ) : (
                              <SquareTerminalIcon className="size-3.5" />
                            )}
                            Terminal
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Reset ${project.name}`}
                            title="Reset project"
                            disabled={Boolean(busyId)}
                            onClick={() => setResetTarget(project)}
                          >
                            {busyId === `${project.id}:reset` ? (
                              <Spinner className="size-4" />
                            ) : (
                              <RefreshCwIcon className="size-4" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${project.name}`}
                            disabled={Boolean(busyId)}
                            onClick={() => void removeProject(project)}
                          >
                            {busyId === project.id ? (
                              <Spinner className="size-4" />
                            ) : (
                              <Trash2Icon className="size-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                      <dl className="mt-3 grid gap-x-5 gap-y-3 sm:grid-cols-2">
                        <ProjectDetail label="Project ID" value={project.id} code wide />
                        <ProjectDetail
                          label="Machine"
                          value={machineName(machines, project.machineId)}
                          secondary={project.machineId}
                        />
                        <ProjectDetail label="Port" value={String(project.port)} code />
                        <ProjectDetail label="Directory" value={project.directory} code wide />
                        <ProjectDetail label="Route" value={project.path} code wide />
                        <ProjectDetail
                          label="Open URL"
                          value={project.openUrl}
                          href={project.openUrl}
                          wide
                        />
                        <ProjectDetail
                          label="Strip prefix"
                          value={project.stripPrefix ? "Yes" : "No"}
                        />
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !busyId) setDeleteTarget(undefined);
        }}
      >
        <AlertDialogContent className="border-border/60 p-5 shadow-2xl dark:border-white/10">
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

      <AlertDialog
        open={Boolean(resetTarget)}
        onOpenChange={(open) => {
          if (!open && !busyId) setResetTarget(undefined);
        }}
      >
        <AlertDialogContent className="border-border/60 p-5 shadow-2xl dark:border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this project?</AlertDialogTitle>
            <AlertDialogDescription>
              {resetTarget
                ? `${resetTarget.name}'s files will be permanently deleted and its saved environment will be recreated.`
                : "The project files will be permanently deleted and its saved environment will be recreated."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busyId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void resetProject();
              }}
            >
              {resetTarget && busyId === `${resetTarget.id}:reset` ? (
                <Spinner className="size-3.5" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              Reset project
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

function ProjectDetail({
  label,
  value,
  secondary,
  href,
  code = false,
  wide = false,
}: {
  label: string;
  value: string;
  secondary?: string;
  href?: string;
  code?: boolean;
  wide?: boolean;
}) {
  const valueClassName = cn("break-all text-sm", code && "font-mono");
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0">
        {href ? (
          <a
            className={cn(valueClassName, "text-primary hover:underline")}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {value}
          </a>
        ) : (
          <span className={valueClassName}>{value}</span>
        )}
        {secondary ? (
          <span className="mt-0.5 block break-all font-mono text-sm text-muted-foreground">
            {secondary}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

function formatExpiration(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
