const fixture = { multiply: (left, right) => left * right };

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
  __pythonInvokeMethod: async (target, name, args) => ({
    ok: true,
    value: await Reflect.apply(target[name], target, args),
  }),
  __pythonModule: (name) => (name === "fixture" ? fixture : undefined),
  abortGlobalsMatch: () => new AbortController().signal instanceof AbortSignal,
  runtimeAbi: () => globalThis[Symbol.for("@dbx-tools/node-runtime/runtime")].abiVersion,
};
