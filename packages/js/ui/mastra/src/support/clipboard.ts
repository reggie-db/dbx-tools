/**
 * Clipboard write that also works off a non-secure origin.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS / localhost).
 * Over plain HTTP - a LAN IP, a ZeroTier address, a port-forwarded dev host -
 * it is `undefined`, so a copy button wired straight to it silently does
 * nothing. {@link copyText} falls back to a hidden `<textarea>` +
 * `document.execCommand("copy")`, which is deprecated but still the only thing
 * that works there.
 *
 * @module
 */

/**
 * Copy `text` to the clipboard, returning whether it succeeded so the caller
 * can decide whether to show a confirmation.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or non-secure context; fall through to execCommand.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
