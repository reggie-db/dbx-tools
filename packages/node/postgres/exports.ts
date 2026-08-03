// Flat re-exports layered onto the generated `index.ts` barrel, which publishes
// each module as a namespace (`advisoryLock`, `topicBus`) and does not lift
// functions to the package root. These are the call-site names, so they are
// importable directly from `@dbx-tools/postgres`.
export {
  advisoryLockId,
  withAdvisoryLock,
  withAdvisoryTransactionLock,
} from "./src/advisory-lock.ts";
// Callers validating a request body or config value before broadcasting need the
// same serializability rule the bus enforces, rather than a second approximation.
export { isSerializableValue } from "./src/topic-bus.ts";
