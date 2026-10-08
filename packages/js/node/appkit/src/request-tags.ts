/** In-process request tags shared by AppKit plugins. */

/** Primitive values supported by the request tag store. */
export type RequestTagValue = string | number | boolean;

type RequestTagMap = Map<string, RequestTagValue>;

const STORE_KEY = Symbol.for("@dbx-tools/appkit/request-tags");
const globalStore = globalThis as typeof globalThis & {
  [STORE_KEY]?: WeakMap<object, RequestTagMap>;
};
const store = (globalStore[STORE_KEY] ??= new WeakMap<object, RequestTagMap>());

/** Inject one tag into an in-process request context. */
export function injectRequestTag(request: object, name: string, value: RequestTagValue): void {
  const normalized = name.trim();
  if (!normalized) return;
  let tags = store.get(request);
  if (!tags) {
    tags = new Map<string, RequestTagValue>();
    store.set(request, tags);
  }
  tags.set(normalized, value);
}

/** Inject multiple tags into an in-process request context. */
export function injectRequestTags(
  request: object,
  tags: Readonly<Record<string, RequestTagValue | undefined>>,
): void {
  for (const [name, value] of Object.entries(tags)) {
    if (value !== undefined) injectRequestTag(request, name, value);
  }
}

/** Read a snapshot of tags injected by AppKit plugins for one request. */
export function getRequestTags(request: object): Readonly<Record<string, RequestTagValue>> {
  return Object.fromEntries(store.get(request) ?? []);
}
