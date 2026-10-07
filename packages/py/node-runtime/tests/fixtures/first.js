const fixture = {
  add: (left, right) => left + right,
  makeCounter: (value) => ({
    value,
    increment(amount) {
      this.value += amount;
      return this.value;
    },
  }),
};

const modules = { fixture: () => fixture };

module.exports = {
  __pythonRuntimeAbiVersion: 1,
  __pythonGet: (target, name) => target[name],
  __pythonInvokePositioned: (fn, entries) => {
    const args = [];
    for (const [index, value] of entries) args[index] = value;
    return fn(...args);
  },
  __pythonKind: (value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value !== "object") return typeof value;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? "record" : "instance";
  },
  __pythonInvokeMethod: async (target, name, args) => {
    try {
      return { ok: true, value: await Reflect.apply(target[name], target, args) };
    } catch (error) {
      return {
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
    }
  },
  __pythonModule: (name) => modules[name](),
  abortGlobalsMatch: () => new AbortController().signal instanceof AbortSignal,
  headersBehave: () => {
    const headers = new Headers({ Authorization: "Bearer secret" });
    headers.append("set-cookie", "first=1");
    headers.append("Set-Cookie", "second=2");
    headers.set("accept", "application/json");
    headers.delete("authorization");
    return {
      accept: headers.get("ACCEPT"),
      authorization: headers.has("Authorization"),
      cookies: headers.getSetCookie(),
      keys: [...headers.keys()],
    };
  },
  runtimeAbi: () => globalThis[Symbol.for("@dbx-tools/node-runtime/runtime")].abiVersion,
};
