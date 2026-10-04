import { Buffer } from "node:buffer";

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;
