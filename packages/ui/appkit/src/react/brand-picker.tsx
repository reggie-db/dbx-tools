import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  cn,
} from "@databricks/appkit-ui/react";
import { brand, object } from "@dbx-tools/shared-core";
import { useBrand } from "@dbx-tools/ui-branding/react";
import { useEffect, useId, useMemo, useState } from "react";

const COLOR_FIELDS = [
  ["primary", "Primary"],
  ["primaryHover", "Primary hover"],
  ["accent", "Accent"],
  ["foreground", "Foreground"],
  ["background", "Background"],
  ["surface", "Surface"],
  ["muted", "Muted"],
  ["border", "Border"],
] as const;

type ColorField = (typeof COLOR_FIELDS)[number][0];

/** One complete brand option shown above the editable fields. */
export interface BrandPreset {
  id: string;
  label: string;
  description?: string;
  context: brand.BrandContextInput;
}

/** Props for {@link BrandPicker}. */
export interface BrandPickerProps {
  /** Current brand. Defaults to the nearest `BrandProvider` context. */
  value?: brand.BrandContextInput;
  /** Receives each valid edited or selected brand context. */
  onChange: (value: brand.BrandContext) => void;
  /** Optional complete brand choices rendered as quick-select buttons. */
  presets?: readonly BrandPreset[];
  /** Value restored by Reset. Defaults to the dbx-tools brand. */
  resetValue?: brand.BrandContextInput;
  /** Show editable icon, logo, and favicon references. */
  showAssets?: boolean;
  className?: string;
}

const validColor = (value: string, fallback: string): string =>
  /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : fallback;

/**
 * Edit a portable `BrandContext` with AppKit-native controls.
 *
 * The picker keeps incomplete text locally while emitting only schema-valid
 * contexts, so controlled hosts can apply changes directly to a
 * `BrandProvider` without guarding every keystroke.
 */
export function BrandPicker({
  value,
  onChange,
  presets = [],
  resetValue = brand.defaultBrandContext,
  showAssets = true,
  className,
}: BrandPickerProps) {
  const { context: inherited } = useBrand();
  const current = useMemo(() => brand.parseBrandContext(value ?? inherited), [inherited, value]);
  const reset = useMemo(() => brand.parseBrandContext(resetValue), [resetValue]);
  const resolvedPresets = useMemo(
    () =>
      presets.map((preset) => ({ ...preset, context: brand.parseBrandContext(preset.context) })),
    [presets],
  );
  const [draft, setDraft] = useState(current);
  const id = useId();

  useEffect(() => setDraft(current), [current]);

  const update = (next: brand.BrandContext) => {
    setDraft(next);
    const parsed = brand.BrandContextSchema.safeParse(next);
    if (parsed.success) onChange(parsed.data);
  };

  const updateIdentity = (field: "name" | "shortName" | "tagline", next: string) =>
    update({ ...draft, [field]: next });

  const updateColor = (field: ColorField, next: string) =>
    update({ ...draft, colors: { ...draft.colors, [field]: next } });

  const updateAsset = (group: "icon" | "logo", mode: "light" | "dark", next: string) =>
    update({
      ...draft,
      assets: {
        ...draft.assets,
        [group]: { ...draft.assets[group], [mode]: next || undefined },
      },
    });

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Brand picker</CardTitle>
            <CardDescription>
              Update identity, AppKit color tokens, document metadata, and email presentation.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(reset);
              onChange(reset);
            }}
          >
            Reset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {resolvedPresets.length ? (
          <section className="space-y-2" aria-label="Brand presets">
            <Label>Presets</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {resolvedPresets.map((preset) => {
                const active = object.deepEqual(current, preset.context);
                return (
                  <Button
                    key={preset.id}
                    type="button"
                    variant={active ? "default" : "outline"}
                    className="h-auto justify-start px-3 py-2 text-left"
                    onClick={() => {
                      setDraft(preset.context);
                      onChange(preset.context);
                    }}
                  >
                    <span>
                      <span className="block text-sm font-medium">{preset.label}</span>
                      {preset.description ? (
                        <span className="block text-xs font-normal opacity-75">
                          {preset.description}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                );
              })}
            </div>
          </section>
        ) : null}

        <Separator />

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Identity</h3>
            <p className="text-xs text-muted-foreground">
              Used by navigation, metadata, and email.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={draft.name}
                onChange={(event) => updateIdentity("name", event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-short-name`}>Short name</Label>
              <Input
                id={`${id}-short-name`}
                value={draft.shortName}
                onChange={(event) => updateIdentity("shortName", event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${id}-tagline`}>Tagline</Label>
              <Input
                id={`${id}-tagline`}
                value={draft.tagline}
                onChange={(event) => updateIdentity("tagline", event.currentTarget.value)}
              />
            </div>
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Color system</h3>
            <p className="text-xs text-muted-foreground">
              Valid hex values are emitted immediately to the active brand provider.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {COLOR_FIELDS.map(([field, label]) => (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={`${id}-${field}`}>{label}</Label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    aria-label={`${label} color`}
                    value={validColor(draft.colors[field], current.colors[field])}
                    className="h-9 w-12 shrink-0 cursor-pointer p-1"
                    onChange={(event) => updateColor(field, event.currentTarget.value)}
                  />
                  <Input
                    id={`${id}-${field}`}
                    value={draft.colors[field]}
                    spellCheck={false}
                    onChange={(event) => updateColor(field, event.currentTarget.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        {showAssets ? (
          <>
            <Separator />
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">Assets</h3>
                <p className="text-xs text-muted-foreground">
                  Package paths, data URLs, and hosted URLs are supported.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["icon", "logo"] as const).flatMap((group) =>
                  (["light", "dark"] as const).map((mode) => (
                    <div key={`${group}-${mode}`} className="space-y-1.5">
                      <Label htmlFor={`${id}-${group}-${mode}`}>
                        {group === "icon" ? "Icon" : "Logo"} · {mode}
                      </Label>
                      <Input
                        id={`${id}-${group}-${mode}`}
                        value={draft.assets[group][mode] ?? ""}
                        spellCheck={false}
                        onChange={(event) => updateAsset(group, mode, event.currentTarget.value)}
                      />
                    </div>
                  )),
                )}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor={`${id}-favicon`}>Favicon</Label>
                  <Input
                    id={`${id}-favicon`}
                    value={draft.assets.favicon}
                    spellCheck={false}
                    onChange={(event) =>
                      update({
                        ...draft,
                        assets: { ...draft.assets, favicon: event.currentTarget.value },
                      })
                    }
                  />
                </div>
              </div>
            </section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
