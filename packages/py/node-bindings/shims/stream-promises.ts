export function finished(stream: {
  once?: (name: string, callback: (error?: Error) => void) => void;
  writableFinished?: boolean;
}): Promise<void> {
  if (stream.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once?.("finish", () => resolve());
    stream.once?.("error", (error) => reject(error));
    if (!stream.once) resolve();
  });
}

export default { finished };
