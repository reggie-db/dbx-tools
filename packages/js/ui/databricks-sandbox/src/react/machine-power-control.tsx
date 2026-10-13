import type { SshMachine } from "@dbx-tools/shared-databricks-sandbox";
import { Button, cn, Spinner } from "@dbx-tools/ui/react";
import { PlayIcon, SquareIcon } from "lucide-react";

/** Start or Stop action shown in the shared machine power control. */
export interface MachinePowerControl {
  action: "start" | "stop";
  enabled: boolean;
}

/**
 * Maps machine lifecycle to one power action.
 * Starting shows a disabled Stop; stopping shows a disabled Start.
 */
export function machinePowerControl(machine: SshMachine): MachinePowerControl {
  if (machine.status === "starting") {
    return { action: "stop", enabled: false };
  }
  if (machine.status === "stopping") {
    return { action: "start", enabled: false };
  }
  if (machine.canStop) {
    return { action: "stop", enabled: true };
  }
  return { action: "start", enabled: machine.canStart };
}

/** Props for the single Start/Stop control that replaces the other action. */
export interface MachinePowerButtonProps {
  machine: SshMachine;
  busy?: boolean;
  iconOnly?: boolean;
  onStart: () => void;
  onStop: () => void;
}

/** Renders Start or Stop in one slot, with a spinner while the machine changes state. */
export function MachinePowerButton({
  machine,
  busy = false,
  iconOnly = false,
  onStart,
  onStop,
}: MachinePowerButtonProps) {
  const power = machinePowerControl(machine);
  const spinning = busy || machine.status === "starting" || machine.status === "stopping";
  const disabled = !power.enabled || busy;
  const iconButtonClassName = iconOnly ? "size-8 shrink-0 p-0" : "shrink-0 px-2 sm:px-3";
  const icon = spinning ? (
    <Spinner className="size-3.5" />
  ) : power.action === "start" ? (
    <PlayIcon className="size-3.5" />
  ) : (
    <SquareIcon className="size-3.5" />
  );
  const label = power.action === "start" ? "Start" : "Stop";
  const title =
    machine.status === "starting"
      ? "Starting"
      : machine.status === "stopping"
        ? "Stopping"
        : spinning
          ? power.action === "start"
            ? "Starting"
            : "Stopping"
          : label;
  if (power.action === "start") {
    return (
      <Button
        size="sm"
        variant="outline"
        className={iconButtonClassName}
        aria-label={`${label} ${machine.name}`}
        title={title}
        aria-busy={spinning}
        disabled={disabled}
        onClick={onStart}
      >
        {icon}
        {iconOnly ? null : <span>{label}</span>}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        iconButtonClassName,
        power.enabled && "text-destructive hover:text-destructive",
      )}
      aria-label={`${label} ${machine.name}`}
      title={title}
      aria-busy={spinning}
      disabled={disabled}
      onClick={onStop}
    >
      {icon}
      {iconOnly ? null : <span>{label}</span>}
    </Button>
  );
}
