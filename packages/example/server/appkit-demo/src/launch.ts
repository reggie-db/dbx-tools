import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const EMOJI = /\p{Extended_Pictographic}\uFE0F?/gu;

export function normalizeProcessOutput(value: string): string {
  return value.replace(EMOJI, "").replace(/^[ \t]+/gm, "");
}

function normalizedOutput(destination: NodeJS.WriteStream): Transform {
  const decoder = new StringDecoder("utf8");
  return new Transform({
    transform(chunk, _encoding, callback) {
      destination.write(normalizeProcessOutput(decoder.write(chunk)));
      callback();
    },
    flush(callback) {
      destination.write(normalizeProcessOutput(decoder.end()));
      callback();
    },
  });
}

const child = spawn("bun", ["src/server.ts"], {
  detached: true,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.pipe(normalizedOutput(process.stdout));
child.stderr.pipe(normalizedOutput(process.stderr));

function forward(signal: NodeJS.Signals): void {
  if (child.pid) process.kill(-child.pid, signal);
}

process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
