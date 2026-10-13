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
  FileTextIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUILT_IN_SERVICE_CONTROLS,
  BuiltInServiceLog,
  BuiltInServiceLauncher,
  InstallLogPanel,
  selectedBuiltInServiceLog,
} from "./built-in-service-launcher.tsx";
import { useSshClient } from "./client.ts";
import { MachinePowerButton } from "./machine-power-control.tsx";
import { resolveServiceUrl } from "./service-url.ts";

const REFRESH_INTERVAL_MS = 5_000;
const CREATE_MACHINE_OPERATION = "machine:create";
const CREATE_PROJECT_OPERATION = "project:create";
const CONFIRMATION_DIALOG_CLASS_NAME =
  "max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto overscroll-contain border-border/60 p-5 shadow-2xl dark:border-white/10";

function machineOperation(machineId: string, action: string): string {
  return `machine:${machineId}:${action}`;
}

function projectOperation(projectId: string, action: string): string {
  return `project:${projectId}:${action}`;
}

/** Props for the full SSH machine and project management surface. */
export interface SshManagerProps {
  basePath?: string;
  className?: string;
}

/** Machine and lifecycle action awaiting user approval. */
interface MachineConfirmation {
  action: "stop" | "delete";
  machine: SshMachine;
}

/** Project and destructive action awaiting user approval. */
interface ProjectConfirmation {
  action: "reset" | "remove";
  project: SshProject;
}

/** Manages existing SSH machines and their persisted Sandbox projects. */
export function SshManager({ basePath, className }: SshManagerProps) {
  const client = useSshClient(basePath);
  const [machines, setMachines] = useState<SshMachine[]>([]);
  const [projects, setProjects] = useState<SshProject[]>([]);
  const [projectPathPrefix, setProjectPathPrefix] = useState("/sandbox");
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyOperations, setBusyOperations] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [machineId, setMachineId] = useState("");
  const [machineConfirmation, setMachineConfirmation] = useState<MachineConfirmation>();
  const displayedMachineConfirmation = useDisplayedDialog(machineConfirmation);
  const [projectConfirmation, setProjectConfirmation] = useState<ProjectConfirmation>();
  const displayedProjectConfirmation = useDisplayedDialog(projectConfirmation);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [port, setPort] = useState("");
  const [path, setPath] = useState("");
  const [openPath, setOpenPath] = useState("");
  const [route, setRoute] = useState(true);
  const [projectServices, setProjectServices] = useState<SshMachineServiceKind[]>([]);
  const [selectedServiceLogs, setSelectedServiceLogs] = useState<
    Readonly<Record<string, { kind: SshMachineServiceKind } | undefined>>
  >({});
  const [selectedProjectLogs, setSelectedProjectLogs] = useState<Readonly<Record<string, boolean>>>(
    {},
  );
  const [stripPrefix, setStripPrefix] = useState(true);
  const refreshing = useRef(false);
  const deletingMachineIds = useRef(new Set<string>());

  const setOperationBusy = useCallback((operation: string, busy: boolean) => {
    setBusyOperations((current) => {
      const next = new Set(current);
      if (busy) next.add(operation);
      else next.delete(operation);
      return next;
    });
  }, []);

  const isBusy = (operation: string) => busyOperations.has(operation);
  const isMachineBusy = (machineId: string) =>
    [...busyOperations].some((operation) => operation.startsWith(`machine:${machineId}:`));
  const isProjectBusy = (projectId: string) =>
    [...busyOperations].some((operation) => operation.startsWith(`project:${projectId}:`));

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
        const visibleMachines = machineResponse.machines.filter(
          (machine) => !deletingMachineIds.current.has(machine.id),
        );
        const visibleProjects = visibleMachines.flatMap((machine) => machine.projects);
        setSupported(machineResponse.supported);
        setMachines(visibleMachines);
        setProjects(visibleProjects);
        setProjectPathPrefix(projectResponse.pathPrefix);
        setMachineId((current) =>
          current && visibleMachines.some((machine) => machine.id === current)
            ? current
            : (visibleMachines[0]?.id ?? ""),
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
    const operation = machineOperation(machine.id, action);
    setOperationBusy(operation, true);
    setError(undefined);
    try {
      await client[action](machine.id);
      await refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setOperationBusy(operation, false);
    }
  };

  const createMachine = async () => {
    setOperationBusy(CREATE_MACHINE_OPERATION, true);
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
      setOperationBusy(CREATE_MACHINE_OPERATION, false);
    }
  };

  const deleteMachine = async (machine: SshMachine) => {
    const operation = machineOperation(machine.id, "delete");
    setOperationBusy(operation, true);
    setError(undefined);
    deletingMachineIds.current.add(machine.id);
    setMachines((current) => {
      const remaining = current.filter((candidate) => candidate.id !== machine.id);
      setMachineId((selected) => (selected === machine.id ? (remaining[0]?.id ?? "") : selected));
      return remaining;
    });
    setProjects((current) => current.filter((project) => project.machineId !== machine.id));
    try {
      await client.delete(machine.id);
      return true;
    } catch (caught) {
      deletingMachineIds.current.delete(machine.id);
      setError(errorMessage(caught));
      await refresh();
      return false;
    } finally {
      deletingMachineIds.current.delete(machine.id);
      setOperationBusy(operation, false);
    }
  };

  const confirmMachineAction = async () => {
    if (!machineConfirmation) return;
    if (machineConfirmation.action === "stop") {
      const machine = machineConfirmation.machine;
      setMachineConfirmation(undefined);
      setMachines((current) =>
        current.map((candidate) =>
          candidate.id === machine.id
            ? { ...candidate, status: "stopping", canStart: false, canStop: true }
            : candidate,
        ),
      );
      void manageMachine(machine, "stop");
      return;
    }
    const completed = await deleteMachine(machineConfirmation.machine);
    if (completed) setMachineConfirmation(undefined);
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
    setOperationBusy(CREATE_PROJECT_OPERATION, true);
    setError(undefined);
    const suffix = path.trim().replace(/^\/+|\/+$/g, "");
    const entry = openPath.trim();
    const input: AddSshProjectRequest = {
      machineId,
      route,
      serviceDependencies: projectServices,
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
      setRoute(true);
      setProjectServices([]);
      setProjectFormOpen(false);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setOperationBusy(CREATE_PROJECT_OPERATION, false);
    }
  };

  const openProjectTerminal = async (project: SshProject) => {
    const operation = projectOperation(project.id, "terminal");
    setOperationBusy(operation, true);
    setError(undefined);
    try {
      const result = await client.openProjectTerminal(project.id);
      if (result.service.state === "ready") {
        window.open(resolveServiceUrl(result.service.openUrl), "_blank", "noopener,noreferrer");
      }
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setOperationBusy(operation, false);
    }
  };

  /** Executes one approved destructive project action. */
  const manageProject = async (
    project: SshProject,
    action: ProjectConfirmation["action"],
  ): Promise<void> => {
    const operation = projectOperation(project.id, action);
    setOperationBusy(operation, true);
    setError(undefined);
    try {
      if (action === "reset") await client.resetProject(project.id);
      else await client.removeProject(project.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      await refresh().catch(() => undefined);
      setOperationBusy(operation, false);
    }
  };

  /** Runs the project action selected in the confirmation dialog. */
  const confirmProjectAction = () => {
    if (!projectConfirmation) return;
    const confirmation = projectConfirmation;
    setProjectConfirmation(undefined);
    void manageProject(confirmation.project, confirmation.action);
  };

  return (
    <div className={cn("space-y-3", className)}>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-foreground"
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
          <Card className="min-w-0 gap-0 py-0">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 px-3 py-2.5 sm:px-4">
              <div className="flex items-center gap-2">
                <CardTitle className="text-sm">Machines</CardTitle>
                <Badge variant="secondary">{machines.length}</Badge>
              </div>
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={isBusy(CREATE_MACHINE_OPERATION)}
                onClick={() => void createMachine()}
              >
                {isBusy(CREATE_MACHINE_OPERATION) ? (
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
                  {machines.map((machine) => {
                    const selectedService = selectedBuiltInServiceLog(
                      machine,
                      selectedServiceLogs[machine.id]?.kind,
                    );
                    return (
                      <div key={machine.id} className="min-w-0 overflow-hidden">
                        <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5 sm:px-4">
                          <span
                            className={cn(
                              "mt-1.5 size-2.5 shrink-0 rounded-full",
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
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-1 border-t bg-muted/20 px-3 py-2 sm:px-4">
                          {BUILT_IN_SERVICE_CONTROLS.map(({ kind }) => (
                            <BuiltInServiceLauncher
                              key={kind}
                              client={client}
                              machine={machine}
                              kind={kind}
                              disabled={isBusy(machineOperation(machine.id, "delete"))}
                              onSnapshot={(snapshot) => {
                                setMachines((current) =>
                                  current.map((candidate) =>
                                    candidate.id === machine.id
                                      ? {
                                          ...candidate,
                                          services: candidate.services.map((currentService) =>
                                            currentService.kind === snapshot.kind
                                              ? snapshot
                                              : currentService,
                                          ),
                                        }
                                      : candidate,
                                  ),
                                );
                              }}
                              onBusyChange={(busy) =>
                                setOperationBusy(machineOperation(machine.id, kind), busy)
                              }
                              onError={setError}
                              logsOpen={selectedServiceLogs[machine.id]?.kind === kind}
                              onSelectLogs={() =>
                                setSelectedServiceLogs((current) => ({
                                  ...current,
                                  [machine.id]: { kind },
                                }))
                              }
                              onHideLogs={() =>
                                setSelectedServiceLogs((current) => ({
                                  ...current,
                                  [machine.id]: undefined,
                                }))
                              }
                              onSettled={refresh}
                            />
                          ))}
                          <div className="ml-auto flex shrink-0 items-center gap-1">
                            <MachinePowerButton
                              machine={machine}
                              iconOnly
                              busy={
                                isBusy(machineOperation(machine.id, "start")) ||
                                isBusy(machineOperation(machine.id, "stop")) ||
                                isBusy(machineOperation(machine.id, "delete"))
                              }
                              onStart={() => void manageMachine(machine, "start")}
                              onStop={() => setMachineConfirmation({ action: "stop", machine })}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              className="size-8 shrink-0 p-0 text-destructive hover:text-destructive"
                              aria-label={`Delete ${machine.name}`}
                              title="Delete"
                              disabled={isMachineBusy(machine.id)}
                              onClick={() => setMachineConfirmation({ action: "delete", machine })}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                        {selectedService ? <BuiltInServiceLog service={selectedService} /> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="min-w-0 gap-0 py-0">
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
                disabled={machines.length === 0 || isBusy(CREATE_PROJECT_OPERATION)}
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
                      disabled={machines.length === 0 || isBusy(CREATE_PROJECT_OPERATION)}
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
                        disabled={isBusy(CREATE_PROJECT_OPERATION)}
                        onChange={(event) => setProjectName(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ssh-project-open-path">Open path</Label>
                      <Input
                        id="ssh-project-open-path"
                        value={openPath}
                        placeholder="open.html"
                        disabled={!route || isBusy(CREATE_PROJECT_OPERATION)}
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
                          disabled={!route || isBusy(CREATE_PROJECT_OPERATION)}
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
                        disabled={!route || isBusy(CREATE_PROJECT_OPERATION)}
                        onChange={(event) => setPort(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={route}
                          disabled={isBusy(CREATE_PROJECT_OPERATION)}
                          onChange={(event) => setRoute(event.target.checked)}
                        />
                        <span>Expose route</span>
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={stripPrefix}
                          disabled={!route || isBusy(CREATE_PROJECT_OPERATION)}
                          onChange={(event) => setStripPrefix(event.target.checked)}
                        />
                        <span>Strip prefix</span>
                      </label>
                    </div>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!machineId || isBusy(CREATE_PROJECT_OPERATION)}
                    >
                      {isBusy(CREATE_PROJECT_OPERATION) ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <PlusIcon className="size-3.5" />
                      )}
                      Add project
                    </Button>
                  </div>
                  <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <legend className="mb-1 text-sm font-medium">Service dependencies</legend>
                    {BUILT_IN_SERVICE_CONTROLS.map(({ kind, label }) => (
                      <label key={kind} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={projectServices.includes(kind)}
                          disabled={isBusy(CREATE_PROJECT_OPERATION)}
                          onChange={(event) =>
                            setProjectServices((current) =>
                              event.target.checked
                                ? [...current, kind]
                                : current.filter((candidate) => candidate !== kind),
                            )
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                </form>
              ) : null}
              {projects.length === 0 ? (
                <div className="flex min-h-16 items-center justify-center border-t px-4 py-4 text-sm text-muted-foreground">
                  No projects yet
                </div>
              ) : (
                <div className="divide-y border-t">
                  {projects.map((project) => {
                    const projectLogOpen = Boolean(selectedProjectLogs[project.id]);
                    return (
                      <div key={project.id} className="min-w-0 overflow-hidden">
                        <div className="px-3 py-3 sm:px-4">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{project.name}</p>
                              <Badge variant={project.state === "ready" ? "secondary" : "outline"}>
                                {project.state}
                              </Badge>
                            </div>
                            <div className="flex w-full min-w-0 flex-wrap items-center gap-1 sm:w-auto sm:shrink-0 sm:flex-nowrap">
                              {project.openUrl ? (
                                <Button type="button" variant="outline" size="sm" asChild>
                                  <a
                                    href={project.openUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    <ExternalLinkIcon className="size-3.5" />
                                    Open
                                  </a>
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`Open terminal for ${project.name}`}
                                disabled={isProjectBusy(project.id)}
                                onClick={() => void openProjectTerminal(project)}
                              >
                                {isBusy(projectOperation(project.id, "terminal")) ? (
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
                                className={cn(projectLogOpen && "bg-muted shadow-inner")}
                                aria-label={
                                  projectLogOpen
                                    ? `Hide install log for ${project.name}`
                                    : `Show install log for ${project.name}`
                                }
                                aria-pressed={projectLogOpen}
                                title={projectLogOpen ? "Hide install log" : "Show install log"}
                                onClick={() =>
                                  setSelectedProjectLogs((current) => ({
                                    ...current,
                                    [project.id]: !current[project.id],
                                  }))
                                }
                              >
                                <FileTextIcon className="size-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Reset ${project.name}`}
                                title="Reset project"
                                disabled={isProjectBusy(project.id)}
                                onClick={() => setProjectConfirmation({ action: "reset", project })}
                              >
                                {isBusy(projectOperation(project.id, "reset")) ? (
                                  <Spinner className="size-4" />
                                ) : (
                                  <RefreshCwIcon className="size-4" />
                                )}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${project.name}`}
                                title="Delete project"
                                disabled={isProjectBusy(project.id)}
                                onClick={() =>
                                  setProjectConfirmation({ action: "remove", project })
                                }
                              >
                                {isBusy(projectOperation(project.id, "remove")) ? (
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
                            <ProjectDetail label="Directory" value={project.directory} code wide />
                            {project.openUrl ? (
                              <>
                                <ProjectDetail label="Port" value={String(project.port)} code />
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
                              </>
                            ) : (
                              <ProjectDetail label="Route" value="Not exposed" wide />
                            )}
                          </dl>
                        </div>
                        {projectLogOpen ? (
                          <InstallLogPanel
                            label={project.name}
                            state={project.state}
                            log={project.log}
                            error={project.error}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <AlertDialog
        open={Boolean(machineConfirmation)}
        onOpenChange={(open) => {
          const operation = machineConfirmation
            ? machineOperation(machineConfirmation.machine.id, machineConfirmation.action)
            : undefined;
          if (!open && (!operation || !isBusy(operation))) setMachineConfirmation(undefined);
        }}
      >
        {displayedMachineConfirmation ? (
          <AlertDialogContent
            key={`${displayedMachineConfirmation.action}:${displayedMachineConfirmation.machine.id}`}
            className={CONFIRMATION_DIALOG_CLASS_NAME}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {displayedMachineConfirmation.action === "delete"
                  ? `Delete ${displayedMachineConfirmation.machine.name}?`
                  : `Stop ${displayedMachineConfirmation.machine.name}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {displayedMachineConfirmation.action === "delete"
                  ? `This permanently deletes ${displayedMachineConfirmation.machine.name}, its machine files, and every project stored on it. This can't be undone.`
                  : "Stopping interrupts active desktop, terminal, and forwarded service sessions. Projects and machine files remain available when you restart."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={Boolean(
                  machineConfirmation &&
                  isBusy(
                    machineOperation(machineConfirmation.machine.id, machineConfirmation.action),
                  ),
                )}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={Boolean(
                  machineConfirmation &&
                  isBusy(
                    machineOperation(machineConfirmation.machine.id, machineConfirmation.action),
                  ),
                )}
                className={cn(
                  displayedMachineConfirmation.action === "delete" &&
                    "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                )}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmMachineAction();
                }}
              >
                {machineConfirmation &&
                isBusy(
                  machineOperation(machineConfirmation.machine.id, machineConfirmation.action),
                ) ? (
                  <Spinner className="size-3.5" />
                ) : displayedMachineConfirmation.action === "delete" ? (
                  <Trash2Icon className="size-3.5" />
                ) : (
                  <SquareIcon className="size-3.5" />
                )}
                {displayedMachineConfirmation.action === "delete"
                  ? "Delete machine"
                  : "Stop machine"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <AlertDialog
        open={Boolean(projectConfirmation)}
        onOpenChange={(open) => {
          if (!open) setProjectConfirmation(undefined);
        }}
      >
        {displayedProjectConfirmation ? (
          <AlertDialogContent
            key={`${displayedProjectConfirmation.action}:${displayedProjectConfirmation.project.id}`}
            className={CONFIRMATION_DIALOG_CLASS_NAME}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {displayedProjectConfirmation.action === "remove"
                  ? `Delete ${displayedProjectConfirmation.project.name}?`
                  : `Reset ${displayedProjectConfirmation.project.name}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {displayedProjectConfirmation.action === "remove"
                  ? `This permanently deletes ${displayedProjectConfirmation.project.name}, its files, saved environment, and route. This can't be undone.`
                  : `${displayedProjectConfirmation.project.name}'s files will be permanently deleted and its saved environment will be recreated.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(event) => {
                  event.preventDefault();
                  confirmProjectAction();
                }}
              >
                {displayedProjectConfirmation.action === "remove" ? (
                  <Trash2Icon className="size-3.5" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
                {displayedProjectConfirmation.action === "remove"
                  ? "Delete project"
                  : "Reset project"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}

/** Keeps dialog copy available while the overlay closes, without a closed-state fallback. */
function useDisplayedDialog<T>(value: T | undefined): T | undefined {
  const displayed = useRef(value);
  if (value) displayed.current = value;
  return displayed.current;
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
