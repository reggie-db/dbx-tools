import { stringUtils } from "@dbx-tools/shared-core";
import type { ReasoningEffort } from "@dbx-tools/shared-model";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Slider,
  Spinner,
} from "@dbx-tools/ui-appkit/react";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ChatModelOption, ChatViewProps } from "./types.ts";

const OTHER_FAMILY = "other";

interface ModelSelectorProps {
  models: ChatModelOption[];
  model?: string;
  defaultModelName?: string;
  defaultModelId?: string;
  defaultModelLoading?: boolean;
  reasoningEffort: ChatViewProps["reasoningEffort"];
  onReasoningEffortChange: ChatViewProps["onReasoningEffortChange"];
  onModelChange: NonNullable<ChatViewProps["onModelChange"]>;
  actions?: ReactNode;
}

/** Convert a normalized family token into a compact menu label. */
function familyLabel(family: string): string {
  return family.length <= 3 ? family.toUpperCase() : stringUtils.toLabel(family);
}

/** Resolve the label shown for a model endpoint. */
function modelLabel(model: ChatModelOption): string {
  return model.displayName || model.name;
}

/** Reasoning selector backed only by efforts published for the active model. */
const ReasoningControl = ({
  efforts,
  value,
  onChange,
}: {
  efforts: ReasoningEffort[];
  value: ChatViewProps["reasoningEffort"];
  onChange: NonNullable<ChatViewProps["onReasoningEffortChange"]>;
}) => {
  const selectedIndex = value === undefined ? 0 : Math.max(0, efforts.indexOf(value) + 1);
  const selectedLabel = value === undefined ? "Auto" : stringUtils.toLabel(value);

  return (
    <div className="space-y-2 px-2 py-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">Reasoning</span>
        <span className="text-muted-foreground">{selectedLabel}</span>
      </div>
      <Slider
        aria-label="Reasoning effort"
        min={0}
        max={efforts.length}
        step={1}
        value={[selectedIndex]}
        onValueChange={([index]) => onChange(index === 0 ? undefined : efforts[index - 1])}
      />
    </div>
  );
};

/** Family menu that opens one scoped endpoint submenu at a time. */
const FamilyPicker = ({
  families,
  selectedModelId,
  model,
  defaultModelName,
  showLoading,
  activeFamily,
  onActiveFamilyChange,
  onModelChange,
}: {
  families: Array<[string, ChatModelOption[]]>;
  selectedModelId?: string;
  model?: string;
  defaultModelName?: string;
  showLoading: boolean;
  activeFamily?: string;
  onActiveFamilyChange: (family: string | undefined) => void;
  onModelChange: NonNullable<ChatViewProps["onModelChange"]>;
}) => {
  if (activeFamily) {
    const options = families.find(([family]) => family === activeFamily)?.[1] ?? [];
    const choices = options.filter((option) => option.name !== selectedModelId);
    return (
      <>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs font-medium outline-none hover:bg-accent focus-visible:bg-accent"
          onClick={() => onActiveFamilyChange(undefined)}
        >
          <ChevronLeftIcon className="size-3" />
          Models
        </button>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup onValueChange={onModelChange}>
          {choices.map((option) => (
            <DropdownMenuRadioItem key={option.name} value={option.name} className="text-xs">
              {modelLabel(option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </>
    );
  }

  return (
    <>
      <DropdownMenuLabel className="text-xs">Models</DropdownMenuLabel>
      <DropdownMenuItem className="gap-2 text-xs" onSelect={() => onModelChange("")}>
        {showLoading ? (
          <>
            <Spinner className="size-3 shrink-0" />
            <span className="sr-only">Loading default model</span>
          </>
        ) : (
          <span>{defaultModelName ? `Default (${defaultModelName})` : "Default"}</span>
        )}
        {!model && !showLoading && <CheckIcon className="ml-auto size-3" />}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {families.map(([family, options]) => {
        if (options.length === 1) {
          const [option] = options;
          if (!option) return null;
          return (
            <DropdownMenuItem
              key={family}
              className="gap-2 text-xs"
              onSelect={() => onModelChange(option.name)}
            >
              <span>{modelLabel(option)}</span>
              {option.name === selectedModelId && <CheckIcon className="ml-auto size-3" />}
            </DropdownMenuItem>
          );
        }
        const choices = options.filter((option) => option.name !== selectedModelId);
        if (choices.length === 0) return null;
        return (
          <button
            key={family}
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent focus-visible:bg-accent"
            onClick={() => onActiveFamilyChange(family)}
          >
            <span>{familyLabel(family)}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">{options.length}</span>
            <ChevronRightIcon className="size-3 text-muted-foreground" />
          </button>
        );
      })}
    </>
  );
};

/**
 * Family-first model picker with fixed model controls above the scrollable
 * family submenus.
 */
export const ModelSelector = ({
  models,
  model,
  defaultModelName,
  defaultModelId,
  defaultModelLoading = false,
  reasoningEffort,
  onReasoningEffortChange,
  onModelChange,
  actions,
}: ModelSelectorProps) => {
  const [open, setOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [activeFamily, setActiveFamily] = useState<string>();
  const selectedModelId = model || defaultModelId;
  const selectedModel = models.find((option) => option.name === selectedModelId);
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const showLoading = defaultModelLoading && !model;
  const triggerLabel = model
    ? modelLabel(models.find((option) => option.name === model) ?? { name: model })
    : defaultModelName || "Default";
  const families = useMemo(() => {
    const grouped = new Map<string, ChatModelOption[]>();
    for (const option of models) {
      const family = option.family || OTHER_FAMILY;
      const current = grouped.get(family);
      if (current) current.push(option);
      else grouped.set(family, [option]);
    }
    return [...grouped.entries()].sort(([left], [right]) => {
      if (left === OTHER_FAMILY) return 1;
      if (right === OTHER_FAMILY) return -1;
      return 0;
    });
  }, [models]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setModelPickerOpen(false);
          setActiveFamily(undefined);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 max-w-[190px] gap-1.5 px-2 text-xs font-normal"
          aria-label={showLoading ? "Loading default model" : `Model: ${triggerLabel}`}
        >
          {showLoading ? (
            <>
              <Spinner className="size-3 shrink-0" />
              <span className="sr-only">Loading default model</span>
            </>
          ) : (
            <>
              <span className="truncate">{triggerLabel}</span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuSub
          open={modelPickerOpen}
          onOpenChange={(next) => {
            if (!next && open) return;
            setModelPickerOpen(next);
            if (!next) setActiveFamily(undefined);
          }}
        >
          <DropdownMenuSubTrigger className="mx-1 justify-center rounded-lg bg-accent/60 px-3 py-2 text-xs font-medium">
            {showLoading ? (
              <>
                <Spinner className="size-3 shrink-0" />
                <span className="sr-only">Loading default model</span>
              </>
            ) : (
              triggerLabel
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-48">
              <FamilyPicker
                families={families}
                selectedModelId={selectedModelId}
                model={model}
                defaultModelName={defaultModelName}
                showLoading={showLoading}
                activeFamily={activeFamily}
                onActiveFamilyChange={setActiveFamily}
                onModelChange={onModelChange}
              />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        {(actions || (reasoningEfforts.length > 0 && onReasoningEffortChange)) && (
          <DropdownMenuSeparator />
        )}
        {actions && <div className="px-1">{actions}</div>}
        {reasoningEfforts.length > 0 && onReasoningEffortChange && (
          <ReasoningControl
            efforts={reasoningEfforts}
            value={reasoningEffort}
            onChange={onReasoningEffortChange}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
