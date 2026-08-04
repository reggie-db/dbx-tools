/**
 * Triggering a browser download of an in-memory file.
 *
 * The chat surface exports from two places - the transcript exporter
 * (markdown / HTML) and the data-grid CSV button - which both need the same
 * blob-URL + synthetic-anchor dance, including revoking the URL so repeated
 * exports do not leak object URLs.
 *
 * @module
 */

/**
 * Download `content` as `filename`. `mime` should include the charset for text
 * formats (e.g. `"text/csv;charset=utf-8"`) so the file opens correctly.
 *
 * The anchor is attached to the document before clicking because Firefox
 * ignores a click on a detached element, and the object URL is revoked on a
 * delay so the download has started before the blob is released.
 */
export function downloadFile(filename: string, content: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
