const defaultedParameters = (source: string): Map<string, Set<string>> => {
  const methods = new Map<string, Set<string>>();
  for (const match of source.matchAll(/^\s*(?:async\s+)?(\w+)\(([^)]*)\)/gm)) {
    const parameters = match[2]
      .split(",")
      .map((parameter) => parameter.trim())
      .filter((parameter) => parameter.includes("="))
      .map((parameter) => parameter.match(/^(\w+)\s*:/)?.[1])
      .filter((parameter): parameter is string => parameter !== undefined);
    if (parameters.length > 0) methods.set(match[1], new Set(parameters));
  }
  return methods;
};

export const makeDefaultedInterfaceParametersOptional = (source: string): string => {
  const defaults = defaultedParameters(source);
  return source.replace(/export interface \w+Like \{[\s\S]*?^\}/gm, (block) =>
    block.replace(/^(\s*)(\w+)\(([^)]*)\)/gm, (signature, indent, method, parameters) => {
      const defaulted = defaults.get(method);
      if (!defaulted) return signature;
      const repaired = parameters
        .split(",")
        .map((parameter: string) => {
          const match = parameter.match(/^(\s*)(\w+)(\s*:\s*.*)$/);
          if (!match || !defaulted.has(match[2])) return parameter;
          return `${match[1]}${match[2]}?${match[3]}`;
        })
        .join(",");
      return `${indent}${method}(${repaired})`;
    }),
  );
};

export interface TypeScriptBindingModule {
  readonly specifier: string;
  readonly source: string;
}

/** Add source extensions to UBRN's generated relative binding imports. */
export const addTypeScriptExtensionsToBindingImports = (source: string): string =>
  source.replace(
    /(["'])\.\/_bindings(-ffi)?\1/g,
    (_specifier, quote: string, suffix: string | undefined) =>
      `${quote}./_bindings${suffix ?? ""}.ts${quote}`,
  );

/** Add explicit type exports for interfaces that TypeScript misses through UBRN's star exports. */
export const addExplicitInterfaceReexports = (
  facade: string,
  modules: readonly TypeScriptBindingModule[],
): string => {
  const exports = modules.flatMap(({ specifier, source }) => {
    const names = [...source.matchAll(/^export interface (\w+)/gm)].map((match) => match[1]!);
    return names.length > 0 ? [`export type { ${names.join(", ")} } from '${specifier}';`] : [];
  });
  if (exports.length === 0) return facade;
  return `${facade.trimEnd()}\n${exports.join("\n")}\n`;
};
