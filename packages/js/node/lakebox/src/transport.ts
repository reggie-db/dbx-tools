import { z } from "zod";

export const SshTransportModeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["auto", "openssh", "ssh2"]))
  .default("auto")
  .describe(
    "SSH transport: auto prefers native OpenSSH with SOCKS5 forwarding and otherwise selects ssh2; explicit modes never switch.",
  );
/** SSH transport selected for a Lakebox session. */
export type SshTransportMode = z.output<typeof SshTransportModeSchema>;

export const Ssh2PatchModeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["auto", "true", "false"]))
  .default("auto")
  .describe(
    "ssh2 missing-exec-reply workaround: auto patches only in development, true requires it, false never patches.",
  );
/** Missing exec-reply patch policy applied when ssh2 is selected. */
export type Ssh2PatchMode = z.output<typeof Ssh2PatchModeSchema>;
