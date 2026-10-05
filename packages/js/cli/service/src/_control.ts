import { rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

export type ServiceControlCommand = "status" | "stop";

export interface ServiceControlResponse {
  readonly running: true;
  readonly pid: number;
  readonly servicePid?: number;
}

export async function requestServiceControl(
  address: string,
  command: ServiceControlCommand,
  timeoutMilliseconds = 500,
): Promise<ServiceControlResponse | undefined> {
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, timeoutMilliseconds);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      try {
        const value = JSON.parse(response) as Partial<ServiceControlResponse>;
        if (value.running === true && typeof value.pid === "number") {
          resolve({
            running: true,
            pid: value.pid,
            ...(typeof value.servicePid === "number" ? { servicePid: value.servicePid } : {}),
          });
          return;
        }
        resolve(undefined);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (["ECONNREFUSED", "ENOENT", "ENOTSOCK", "EPIPE"].includes(error.code ?? "")) {
        resolve(undefined);
        return;
      }
      reject(error);
    });
  });
}

export async function listenForServiceControl(
  address: string,
  status: () => ServiceControlResponse,
  stop: () => void,
): Promise<Server> {
  const server = createServer((socket) => handleConnection(socket, status, stop));
  try {
    await listen(server, address);
    return server;
  } catch (error) {
    if (isWindowsPipe(address) || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw error;
    }
    if ((await requestServiceControl(address, "status")) !== undefined) {
      throw new Error(`service control address is already active: ${address}`);
    }
    await rm(address, { force: true });
    await listen(server, address);
    return server;
  }
}

export async function closeServiceControl(server: Server, address: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!isWindowsPipe(address)) await rm(address, { force: true });
}

function handleConnection(
  socket: Socket,
  status: () => ServiceControlResponse,
  stop: () => void,
): void {
  let request = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    request += chunk;
    if (!request.includes("\n")) return;
    socket.removeAllListeners("data");
    let command: unknown;
    try {
      command = (JSON.parse(request) as { command?: unknown }).command;
    } catch {
      socket.end();
      return;
    }
    socket.end(`${JSON.stringify(status())}\n`);
    if (command === "stop") setImmediate(stop);
  });
}

async function listen(server: Server, address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isWindowsPipe(address: string): boolean {
  return address.startsWith("\\\\.\\pipe\\");
}
