interface ReadLine extends AsyncIterable<string> {
  close(): void;
}

export function createInterface(options: { input: AsyncIterable<unknown> }): ReadLine {
  return {
    close() {},
    async *[Symbol.asyncIterator]() {
      let pending = "";
      for await (const chunk of options.input) {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        yield* lines;
      }
      if (pending) yield pending;
    },
  };
}

export default { createInterface };
