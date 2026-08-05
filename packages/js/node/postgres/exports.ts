// Flat re-exports layered onto the generated `index.ts` barrel, which publishes
// each module as a namespace (`advisoryLock`, `topicBus`) and does not lift
// functions to the package root. These are the call-site names, so they are
// importable directly from `@dbx-tools/postgres`.
export {
  advisoryLockId,
  withAdvisoryLock,
  withAdvisoryTransactionLock,
} from "./src/advisory-lock.ts";
export {
  decodePointer,
  messageBusGrantStatements,
  provisionMessageBusSchema,
  resolvePersistenceOptions,
} from "./src/persistence.ts";
export type {
  TopicPersistenceScope,
  TopicBusPersistenceOptions,
  StoredTopicMessage,
  TopicHistoryPage,
  TopicPointer,
} from "./src/persistence.ts";
