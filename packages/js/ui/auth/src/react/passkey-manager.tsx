import { Button, Input } from "@dbx-tools/ui-appkit/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  addPasskey,
  listPasskeys,
  type PasskeySummary,
  removePasskey,
  renamePasskey,
} from "./auth-client.ts";

export interface PasskeyManagerProps {
  className?: string;
}

/** Authenticated management surface for a user's Better Auth passkeys. */
export function PasskeyManager({ className }: PasskeyManagerProps): ReactNode {
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const values = await listPasskeys();
    setPasskeys(values);
    setNames(Object.fromEntries(values.map((passkey) => [passkey.id, passkey.name ?? "Passkey"])));
  }, []);

  useEffect(() => {
    void refresh().catch(() => setNotice("Unable to load passkeys."));
  }, [refresh]);

  const add = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (!(await addPasskey())) throw new Error("Passkey enrollment failed");
      await refresh();
    } catch {
      setNotice("Unable to add a passkey.");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const rename = useCallback(
    async (id: string) => {
      const name = names[id]?.trim();
      if (!name) return;
      setBusy(true);
      try {
        if (!(await renamePasskey(id, name))) throw new Error("Passkey rename failed");
        await refresh();
      } catch {
        setNotice("Unable to rename the passkey.");
      } finally {
        setBusy(false);
      }
    },
    [names, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        if (!(await removePasskey(id))) throw new Error("Passkey removal failed");
        await refresh();
      } catch {
        setNotice("Unable to remove the passkey.");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <section className={className} aria-label="Passkeys">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium text-foreground">Passkeys</h2>
          <p className="text-sm text-muted-foreground">
            Add more than one device so email remains recovery, not your daily sign-in.
          </p>
        </div>
        <Button type="button" onClick={add} disabled={busy}>
          Add passkey
        </Button>
      </div>
      <div className="space-y-2">
        {passkeys.map((passkey) => (
          <div key={passkey.id} className="flex items-center gap-2 rounded-md border p-2">
            <Input
              aria-label="Passkey name"
              value={names[passkey.id] ?? ""}
              onChange={(event) =>
                setNames((current) => ({ ...current, [passkey.id]: event.target.value }))
              }
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => rename(passkey.id)}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => remove(passkey.id)}
            >
              Remove
            </Button>
          </div>
        ))}
        {passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No passkeys enrolled.</p>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
