/**
 * Async line reader used by subprocess output capture in PythonMonkey bundles.
 *
 * @module
 */

interface ReadLineOptions {
  readonly input: AsyncIterable<unknown>;
}

class PythonReadLine implements AsyncIterable<string> {
  private closed = false;

  constructor(private readonly input: AsyncIterable<unknown>) {}

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    let buffered = "";
    for await (const chunk of this.input) {
      if (this.closed) break;
      buffered += String(chunk);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    if (!this.closed && buffered) yield buffered.replace(/\r$/, "");
  }

  close(): void {
    this.closed = true;
  }
}

export function createInterface(options: ReadLineOptions): PythonReadLine {
  return new PythonReadLine(options.input);
}

export default { createInterface };
