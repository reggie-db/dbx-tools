import { readFileSync } from "node:fs";

import { parseSync, Severity, type Comment, type ParseResult } from "oxc-parser";

import {
  DatabricksOpenapiError,
  type DatabricksApiIr,
  type DatabricksOperation,
  type DatabricksSdkInput,
  type ExtractionDiagnostic,
  type OperationParameter,
  type ResolvedSdkInput,
  type SourceLocation,
  type WireComponent,
  type WireSchema,
} from "./types.ts";

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

interface ParsedSource {
  file: string;
  source: string;
  program: AstNode;
  comments: Comment[];
  lineStarts: number[];
}

interface SchemaResult {
  schema: WireSchema;
  optional: boolean;
}

interface SchemaDefinition {
  name: string;
  canonicalName: string;
  initializer: AstNode;
  location: SourceLocation;
}

interface SchemaContext {
  parsed: ParsedSource;
  definitions: Map<string, SchemaDefinition>;
  enums: Map<string, unknown[]>;
  diagnostics: ExtractionDiagnostic[];
  sourceSchema: string;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const MODIFIER_METHODS = new Set(["optional", "nullable", "nullish", "default", "transform"]);

function isNode(value: unknown): value is AstNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (isNode(value)) {
      children.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) children.push(item);
      }
    }
  }
  return children;
}

function walk(
  node: AstNode,
  visitor: (node: AstNode, ancestors: readonly AstNode[]) => void,
  ancestors: readonly AstNode[] = [],
): void {
  visitor(node, ancestors);
  const next = [...ancestors, node];
  for (const child of childNodes(node)) walk(child, visitor, next);
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function sourceLocation(parsed: ParsedSource, offset: number): SourceLocation {
  let low = 0;
  let high = parsed.lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((parsed.lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle;
  }
  return {
    file: parsed.file,
    line: low + 1,
    column: offset - (parsed.lineStarts[low] ?? 0) + 1,
  };
}

function parseSource(file: string, source: string): ParsedSource {
  let result: ParseResult;
  try {
    result = parseSync(file, source, {
      lang: file.endsWith(".ts") ? "ts" : "js",
      sourceType: "module",
      showSemanticErrors: true,
    });
  } catch (cause) {
    throw new DatabricksOpenapiError(
      `Unable to parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const starts = lineStarts(source);
  const diagnostics = result.errors
    .filter((error) => error.severity === Severity.Error)
    .map<ExtractionDiagnostic>((error) => {
      const offset = error.labels.at(0)?.start ?? 0;
      let line = 0;
      let high = starts.length;
      while (line + 1 < high) {
        const middle = Math.floor((line + high) / 2);
        if ((starts[middle] ?? 0) <= offset) line = middle;
        else high = middle;
      }
      return {
        code: "SDK_PARSE_ERROR",
        message: error.message,
        severity: "error",
        location: {
          file,
          line: line + 1,
          column: offset - (starts[line] ?? 0) + 1,
        },
      };
    });
  if (diagnostics.length > 0) {
    throw new DatabricksOpenapiError(`Unable to parse ${file}`, diagnostics);
  }

  return {
    file,
    source,
    program: result.program as unknown as AstNode,
    comments: result.comments,
    lineStarts: starts,
  };
}

function identifierName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "PrivateIdentifier") return node.name as string;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

function literalValue(node: unknown): unknown {
  if (!isNode(node)) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-" && isNode(node.argument)) {
    const argument = literalValue(node.argument);
    return typeof argument === "number" ? -argument : undefined;
  }
  return undefined;
}

function propertyName(node: AstNode): string | undefined {
  return identifierName(node.key);
}

function calleeName(node: AstNode): string | undefined {
  if (node.type !== "CallExpression") return undefined;
  return identifierName(node.callee);
}

function memberMethod(node: AstNode): string | undefined {
  if (node.type !== "CallExpression" || !isNode(node.callee)) return undefined;
  if (node.callee.type !== "MemberExpression") return undefined;
  return identifierName(node.callee.property);
}

function unwrapChain(node: AstNode): AstNode {
  let current = node;
  while (
    (current.type === "ChainExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression") &&
    isNode(current.expression)
  ) {
    current = current.expression;
  }
  return current;
}

function memberPath(node: AstNode, root: string): string | undefined {
  const current = unwrapChain(node);
  if (current.type === "Identifier") {
    return current.name === root ? "" : undefined;
  }
  if (current.type === "LogicalExpression" && current.operator === "??" && isNode(current.left)) {
    return memberPath(current.left, root);
  }
  if (current.type === "CallExpression") {
    const name = calleeName(current);
    const args = current.arguments as AstNode[];
    if ((name === "String" || name === "Number") && isNode(args?.[0])) {
      return memberPath(args[0], root);
    }
    if (isNode(current.callee) && current.callee.type === "MemberExpression") {
      const method = identifierName(current.callee.property);
      if (method === "toString" && isNode(current.callee.object)) {
        return memberPath(current.callee.object, root);
      }
    }
  }
  if (current.type !== "MemberExpression" || !isNode(current.object)) return undefined;
  const parent = memberPath(current.object, root);
  const property = identifierName(current.property);
  if (parent === undefined || property === undefined) return undefined;
  return parent ? `${parent}.${property}` : property;
}

function variableInitializers(method: AstNode): Map<string, AstNode> {
  const variables = new Map<string, AstNode>();
  walk(method, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const name = identifierName(node.id);
    if (name && isNode(node.init)) variables.set(name, node.init);
  });
  return variables;
}

function resolveVariable(node: AstNode, variables: Map<string, AstNode>): AstNode {
  let current = node;
  const seen = new Set<string>();
  while (current.type === "Identifier") {
    const name = identifierName(current);
    if (!name || seen.has(name)) break;
    const next = variables.get(name);
    if (!next) break;
    seen.add(name);
    current = next;
  }
  return unwrapChain(current);
}

function urlTemplate(
  node: AstNode,
  variables: Map<string, AstNode>,
  diagnostics: ExtractionDiagnostic[],
  parsed: ParsedSource,
): { path: string; fields: string[] } {
  const fields: string[] = [];

  const render = (raw: AstNode): string => {
    const current = resolveVariable(raw, variables);
    if (current.type === "Literal" && typeof current.value === "string") return current.value;
    if (current.type === "ConditionalExpression" && isNode(current.alternate)) {
      return render(current.alternate);
    }
    if (current.type === "LogicalExpression" && current.operator === "??" && isNode(current.left)) {
      return render(current.left);
    }
    if (current.type === "CallExpression" && calleeName(current) === "encodeMultiSegmentPath") {
      const argument = (current.arguments as AstNode[])[0];
      if (isNode(argument)) return render(argument);
    }
    if (current.type === "TemplateLiteral") {
      const quasis = current.quasis as AstNode[];
      const expressions = current.expressions as AstNode[];
      let output = "";
      for (let index = 0; index < quasis.length; index += 1) {
        const quasi = quasis[index];
        const value = isNode(quasi) ? (quasi.value as { cooked?: string })?.cooked : "";
        output += value ?? "";
        const expression = expressions[index];
        if (!isNode(expression)) continue;
        const sdkField = memberPath(expression, "req");
        if (sdkField !== undefined) {
          fields.push(sdkField);
          output += `{${sdkField.split(".").at(-1) ?? sdkField}}`;
          continue;
        }
        const name = identifierName(expression);
        if (name === "host" || name === "query" || name === "params") continue;
        if (name && variables.has(name)) {
          output += render(expression);
          continue;
        }
        if (
          expression.type === "CallExpression" &&
          calleeName(expression) === "encodeMultiSegmentPath"
        ) {
          output += render(expression);
          continue;
        }
        diagnostics.push({
          code: "UNSUPPORTED_URL_EXPRESSION",
          message: `Unsupported URL expression ${parsed.source.slice(expression.start, expression.end)}`,
          severity: "error",
          location: sourceLocation(parsed, expression.start),
        });
      }
      return output;
    }
    const sdkField = memberPath(current, "req");
    if (sdkField !== undefined) {
      fields.push(sdkField);
      return `{${sdkField.split(".").at(-1) ?? sdkField}}`;
    }
    diagnostics.push({
      code: "UNSUPPORTED_URL",
      message: `Unsupported URL syntax ${parsed.source.slice(current.start, current.end)}`,
      severity: "error",
      location: sourceLocation(parsed, current.start),
    });
    return "";
  };

  const rendered = render(node);
  const path = rendered.split("?")[0]?.replace(/^https?:\/\/[^/]+/, "") ?? rendered;
  return { path: path.startsWith("/") ? path : `/${path}`, fields };
}

function docComment(parsed: ParsedSource, node: AstNode): string | undefined {
  const comment = parsed.comments
    .filter(
      (candidate) =>
        candidate.type === "Block" &&
        candidate.value.startsWith("*") &&
        candidate.end <= node.start &&
        parsed.source.slice(candidate.end, node.start).trim() === "",
    )
    .at(-1);
  if (!comment) return undefined;
  const description = comment.value
    .replace(/^\*+/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
  return description || undefined;
}

function methodDescription(parsed: ParsedSource, method: AstNode): string | undefined {
  return docComment(parsed, method);
}

interface DeclarationField {
  resourceFormat?: string;
  typeName?: string;
}

function declarationTypeName(member: AstNode): string | undefined {
  let typeName: string | undefined;
  walk(member, (node) => {
    if (typeName || node.type !== "TSTypeReference") return;
    typeName = identifierName(node.typeName);
  });
  return typeName;
}

function declarationFields(parsed: ParsedSource): Map<string, Map<string, DeclarationField>> {
  const interfaces = new Map<string, Map<string, DeclarationField>>();
  walk(parsed.program, (node) => {
    if (node.type !== "TSInterfaceDeclaration") return;
    const interfaceName = identifierName(node.id);
    const body = isNode(node.body) ? (node.body.body as AstNode[]) : [];
    if (!interfaceName || !Array.isArray(body)) return;
    const fields = new Map<string, DeclarationField>();
    for (const member of body) {
      if (!isNode(member) || member.type !== "TSPropertySignature") continue;
      const fieldName = identifierName(member.key);
      const description = docComment(parsed, member);
      const resourceFormat =
        description?.match(/\bFormat:\s*["'`]?([A-Za-z0-9_{}*./-]+)/i)?.[1] ??
        description?.match(/\bResource name:\s*["'`]?([A-Za-z0-9_{}*./-]+)/i)?.[1] ??
        description?.match(/\bof the format\s*["'`]?([A-Za-z0-9_{}*./-]+)/i)?.[1];
      const typeName = declarationTypeName(member);
      if (fieldName && (resourceFormat || typeName)) {
        fields.set(fieldName, { resourceFormat, typeName });
      }
    }
    if (fields.size > 0) interfaces.set(interfaceName, fields);
  });
  return interfaces;
}

function declarationResourceFormat(
  interfaces: Map<string, Map<string, DeclarationField>>,
  requestName: string,
  sdkName: string,
): string | undefined {
  let fields = interfaces.get(requestName);
  const segments = sdkName.split(".");
  for (const [index, segment] of segments.entries()) {
    const field = fields?.get(segment);
    if (!field) return undefined;
    if (index === segments.length - 1) return field.resourceFormat;
    fields = field.typeName ? interfaces.get(field.typeName) : undefined;
  }
  return undefined;
}

function upperInitial(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function applyDeclarationResourcePaths(
  operations: DatabricksOperation[],
  parsed: ParsedSource,
): void {
  const interfaces = declarationFields(parsed);
  for (const operation of operations) {
    const requestName = `${upperInitial(operation.methodName)}Request`;
    const replacementParameters: OperationParameter[] = [];
    const replaced = new Set<OperationParameter>();
    for (const parameter of operation.parameters) {
      if (parameter.location !== "path") continue;
      const format = declarationResourceFormat(interfaces, requestName, parameter.sdkName);
      if (!format || !operation.path.includes(`{${parameter.wireName}}`)) continue;
      operation.path = operation.path.replace(`{${parameter.wireName}}`, format);
      replaced.add(parameter);
      for (const wireName of pathPlaceholders(format)) {
        replacementParameters.push({
          sdkName: parameter.sdkName,
          wireName,
          location: "path",
          required: true,
          schema: { type: "string" },
          resourcePattern: format,
        });
      }
    }
    if (replaced.size > 0) {
      operation.parameters = [
        ...operation.parameters.filter((parameter) => !replaced.has(parameter)),
        ...replacementParameters,
      ];
    }
    operation.scope = operation.path.includes("/accounts/")
      ? "account"
      : operation.path.startsWith("/serving-endpoints/")
        ? "data-plane"
        : "workspace";
  }
}

function classBindings(parsed: ParsedSource): { name: string; node: AstNode }[] {
  const classes: { name: string; node: AstNode }[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (
      node.type !== "VariableDeclarator" ||
      ancestors.some((item) => item.type.includes("Function"))
    ) {
      return;
    }
    const name = identifierName(node.id);
    if (name && isNode(node.init) && node.init.type === "ClassExpression") {
      classes.push({ name, node: node.init });
    }
  });
  return classes;
}

function directCalls(method: AstNode, name: string): AstNode[] {
  const calls: AstNode[] = [];
  walk(method, (node) => {
    if (node.type === "CallExpression" && calleeName(node) === name) calls.push(node);
  });
  return calls;
}

function queryParameters(method: AstNode): OperationParameter[] {
  const parameters: OperationParameter[] = [];
  walk(method, (node, ancestors) => {
    if (node.type !== "CallExpression" || memberMethod(node) !== "append") return;
    if (!isNode(node.callee) || node.callee.type !== "MemberExpression") return;
    const owner = identifierName(node.callee.object);
    if (owner !== "params" && owner !== "query") return;
    const args = node.arguments as AstNode[];
    const wireName = literalValue(args?.[0]);
    const sdkName = isNode(args?.[1]) ? memberPath(args[1], "req") : undefined;
    if (typeof wireName !== "string" || sdkName === undefined) return;
    parameters.push({
      sdkName,
      wireName,
      location: "query",
      required: !ancestors.some((ancestor) => ancestor.type === "IfStatement"),
      schema: { type: "string" },
    });
  });
  return parameters;
}

function extractMarshal(
  node: AstNode | undefined,
  variables: Map<string, AstNode>,
): { sourcePath: string; schemaName: string } | undefined {
  if (!node) return undefined;
  const resolved = resolveVariable(node, variables);
  if (resolved.type !== "CallExpression" || calleeName(resolved) !== "marshalRequest") {
    const sourcePath = memberPath(resolved, "req");
    return sourcePath === undefined ? undefined : { sourcePath, schemaName: "BinaryRequest" };
  }
  const args = resolved.arguments as AstNode[];
  const sourcePath = isNode(args?.[0]) ? memberPath(args[0], "req") : undefined;
  const schemaName = identifierName(args?.[1]);
  if (sourcePath === undefined || !schemaName) return undefined;
  return { sourcePath, schemaName };
}

function extractResponse(
  method: AstNode,
  parsed: ParsedSource,
  diagnostics: ExtractionDiagnostic[],
): DatabricksOperation["response"] {
  const calls = directCalls(method, "parseResponse");
  if (calls.length > 0) {
    const args = calls[0]?.arguments as AstNode[];
    const schemaName = identifierName(args?.[1]);
    if (schemaName) {
      return { kind: "json", schemaName, status: "200", mediaType: "application/json" };
    }
    if (isNode(args?.[1])) {
      const collected = collectSchemaDefinitions(parsed);
      return {
        kind: "json",
        inlineSchema: parseZod(args[1], {
          parsed,
          definitions: collected.definitions,
          enums: collected.enums,
          diagnostics,
          sourceSchema: "inline response",
        }).schema,
        status: "200",
        mediaType: "application/json",
      };
    }
  }
  if (directCalls(method, "sendAndCheckError").length > 0) return { kind: "raw" };
  return { kind: "none", status: "204" };
}

function lowerInitial(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value;
}

function publicMethodName(value: string): string {
  return value.endsWith("Base") ? value.slice(0, -4) : value;
}

function extractOperations(
  parsed: ParsedSource,
  diagnostics: ExtractionDiagnostic[],
): { clientClass: string; serviceName: string; operations: DatabricksOperation[] } {
  const operations: DatabricksOperation[] = [];
  let selectedClass = "";
  for (const binding of classBindings(parsed)) {
    const classBody = isNode(binding.node.body) ? (binding.node.body.body as AstNode[]) : [];
    for (const method of classBody ?? []) {
      if (!isNode(method) || method.type !== "MethodDefinition" || !isNode(method.value)) continue;
      const requests = directCalls(method.value, "buildHttpRequest");
      if (requests.length === 0) continue;
      if (requests.length > 1) {
        diagnostics.push({
          code: "MULTIPLE_HTTP_CALLS",
          message: `Method ${identifierName(method.key) ?? "<unknown>"} contains multiple buildHttpRequest calls`,
          severity: "error",
          location: sourceLocation(parsed, method.start),
        });
        continue;
      }
      selectedClass ||= binding.name;
      if (selectedClass !== binding.name) {
        diagnostics.push({
          code: "MULTIPLE_CLIENT_CLASSES",
          message: `HTTP calls occur in both ${selectedClass} and ${binding.name}`,
          severity: "error",
          location: sourceLocation(parsed, method.start),
        });
        continue;
      }

      const request = requests[0] as AstNode;
      const args = request.arguments as AstNode[];
      const httpMethod = literalValue(args?.[0]);
      if (typeof httpMethod !== "string" || !HTTP_METHODS.has(httpMethod)) {
        diagnostics.push({
          code: "UNSUPPORTED_HTTP_METHOD",
          message: "buildHttpRequest requires a literal supported HTTP method",
          severity: "error",
          location: sourceLocation(parsed, request.start),
        });
        continue;
      }
      if (!isNode(args?.[1])) {
        diagnostics.push({
          code: "MISSING_URL",
          message: "buildHttpRequest has no URL expression",
          severity: "error",
          location: sourceLocation(parsed, request.start),
        });
        continue;
      }

      const variables = variableInitializers(method.value);
      const extractedUrl = urlTemplate(args[1], variables, diagnostics, parsed);
      const parameters = queryParameters(method.value);
      for (const field of extractedUrl.fields) {
        parameters.push({
          sdkName: field,
          wireName: field.split(".").at(-1) ?? field,
          location: "path",
          required: true,
          schema: { type: "string" },
        });
      }

      const marshal = extractMarshal(isNode(args?.[4]) ? args[4] : undefined, variables);
      if (args?.[4] && !marshal) {
        diagnostics.push({
          code: "UNSUPPORTED_REQUEST_BODY",
          message: "Request body is not a direct marshalRequest result",
          severity: "error",
          location: sourceLocation(parsed, (args[4] as AstNode).start),
        });
      }
      const rawMethod = identifierName(method.key) ?? "";
      const methodName = publicMethodName(rawMethod);
      const serviceName = lowerInitial(binding.name.replace(/Client$/, ""));
      operations.push({
        operationId: `${serviceName}.${methodName}`,
        clientClass: binding.name,
        methodName,
        description: methodDescription(parsed, method),
        httpMethod,
        sdkPath: extractedUrl.path,
        path: extractedUrl.path,
        parameters,
        body: marshal
          ? {
              ...marshal,
              required: false,
              mediaType:
                marshal.schemaName === "BinaryRequest"
                  ? "application/octet-stream"
                  : "application/json",
            }
          : undefined,
        response: extractResponse(method.value, parsed, diagnostics),
        scope: "workspace",
        location: sourceLocation(parsed, method.start),
      });
    }
  }

  if (!selectedClass) {
    diagnostics.push({
      code: "MISSING_CLIENT_CLASS",
      message: "No class contains a direct buildHttpRequest call",
      severity: "error",
      location: sourceLocation(parsed, 0),
    });
  }

  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.operationId)) {
      diagnostics.push({
        code: "DUPLICATE_OPERATION",
        message: `Duplicate operation id ${operation.operationId}`,
        severity: "error",
        location: operation.location,
      });
    }
    ids.add(operation.operationId);
  }

  return {
    clientClass: selectedClass,
    serviceName: lowerInitial(selectedClass.replace(/Client$/, "")),
    operations: operations.sort((left, right) => left.operationId.localeCompare(right.operationId)),
  };
}

function canonicalSchemaName(name: string): string {
  return name.replace(/^(?:unmarshal|marshal)/, "").replace(/Schema$/, "");
}

function collectSchemaDefinitions(parsed: ParsedSource): {
  definitions: Map<string, SchemaDefinition>;
  enums: Map<string, unknown[]>;
} {
  const definitions = new Map<string, SchemaDefinition>();
  const enums = new Map<string, unknown[]>();
  walk(parsed.program, (node, ancestors) => {
    if (
      node.type !== "VariableDeclarator" ||
      ancestors.some((item) => item.type.includes("Function"))
    ) {
      return;
    }
    const name = identifierName(node.id);
    if (!name || !isNode(node.init)) return;
    if ((name.startsWith("marshal") || name.startsWith("unmarshal")) && name.endsWith("Schema")) {
      definitions.set(name, {
        name,
        canonicalName: canonicalSchemaName(name),
        initializer: node.init,
        location: sourceLocation(parsed, node.start),
      });
      return;
    }
    if (node.init.type !== "ObjectExpression") return;
    const values: unknown[] = [];
    for (const property of node.init.properties as AstNode[]) {
      if (!isNode(property) || property.type !== "Property" || !isNode(property.value)) continue;
      const value = literalValue(property.value);
      if (value !== undefined) values.push(value);
    }
    if (values.length > 0) enums.set(name, values);
  });
  return { definitions, enums };
}

function callMember(
  node: AstNode,
): { object: AstNode; method: string; args: AstNode[] } | undefined {
  const current = unwrapChain(node);
  if (current.type !== "CallExpression" || !isNode(current.callee)) return undefined;
  if (current.callee.type !== "MemberExpression" || !isNode(current.callee.object))
    return undefined;
  const method = identifierName(current.callee.property);
  if (!method) return undefined;
  return {
    object: current.callee.object,
    method,
    args: (current.arguments as AstNode[]) ?? [],
  };
}

function nullable(schema: WireSchema): WireSchema {
  if (Array.isArray(schema.type)) {
    return { ...schema, type: [...new Set([...schema.type, "null"])] };
  }
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

function schemaAtPath(schema: WireSchema, path: string[]): WireSchema | undefined {
  if (path.length === 0) return schema;
  const [first, ...rest] = path;
  const properties = schema.properties as Record<string, WireSchema> | undefined;
  if (first && properties?.[first]) return schemaAtPath(properties[first], rest);
  for (const keyword of ["oneOf", "anyOf"]) {
    const branches = schema[keyword] as WireSchema[] | undefined;
    for (const branch of branches ?? []) {
      const found = schemaAtPath(branch, path);
      if (found) return found;
    }
  }
  return undefined;
}

function unsupportedSchema(node: AstNode, context: SchemaContext, message: string): SchemaResult {
  context.diagnostics.push({
    code: "UNSUPPORTED_ZOD_SYNTAX",
    message: `${context.sourceSchema}: ${message}: ${context.parsed.source.slice(node.start, node.end)}`,
    severity: "error",
    location: sourceLocation(context.parsed, node.start),
  });
  return { schema: {}, optional: false };
}

function parseObject(node: AstNode, context: SchemaContext): SchemaResult {
  if (node.type !== "ObjectExpression") {
    return unsupportedSchema(node, context, "z.object requires an object literal");
  }
  const properties: Record<string, WireSchema> = {};
  const required: string[] = [];
  for (const property of node.properties as AstNode[]) {
    if (!isNode(property) || property.type !== "Property" || !isNode(property.value)) {
      if (isNode(property)) unsupportedSchema(property, context, "Unsupported object property");
      continue;
    }
    const name = propertyName(property);
    if (!name) {
      unsupportedSchema(property, context, "Object property requires a static name");
      continue;
    }
    const parsed = parseZod(property.value, context);
    properties[name] = parsed.schema;
    if (!parsed.optional) required.push(name);
  }
  const schema: WireSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required.sort();
  return { schema, optional: false };
}

function parseZod(node: AstNode, context: SchemaContext): SchemaResult {
  const current = unwrapChain(node);
  const member = callMember(current);
  if (!member) {
    if (current.type === "Identifier") {
      const name = identifierName(current) as string;
      if (name === "jsonValueSchema") {
        context.diagnostics.push({
          code: "UNCONSTRAINED_JSON_VALUE",
          message: `${context.sourceSchema} accepts an arbitrary JSON value`,
          severity: "warning",
          location: sourceLocation(context.parsed, current.start),
        });
        return { schema: {}, optional: false };
      }
      if (name === "jsonObjectSchema") {
        return {
          schema: { type: "object", additionalProperties: true },
          optional: false,
        };
      }
      if (context.definitions.has(name)) {
        return {
          schema: { $ref: `#/components/schemas/${canonicalSchemaName(name)}` },
          optional: false,
        };
      }
      const values = context.enums.get(name);
      if (values) return { schema: { type: "string", enum: values }, optional: false };
    }
    return unsupportedSchema(current, context, "Expected a generated Zod expression");
  }

  if (MODIFIER_METHODS.has(member.method)) {
    if (member.method === "optional") {
      const parsed = parseZod(member.object, context);
      return { ...parsed, optional: true };
    }
    if (member.method === "nullable" || member.method === "nullish") {
      const parsed = parseZod(member.object, context);
      return {
        schema: nullable(parsed.schema),
        optional: parsed.optional || member.method === "nullish",
      };
    }
    if (member.method === "default") {
      const parsed = parseZod(member.object, context);
      const value = literalValue(member.args[0]);
      if (value !== undefined) parsed.schema = { ...parsed.schema, default: value };
      return { ...parsed, optional: true };
    }
    const parsed = parseZod(member.object, context);
    if ((parsed.schema.type as string | undefined) === "object") return parsed;
    const source = context.parsed.source.slice(current.start, current.end);
    if (/\b(?:atob|btoa)\(/.test(source)) {
      return { schema: { type: "string", format: "byte" }, optional: false };
    }
    if (/\.toString\(\)/.test(source)) {
      return { schema: { type: "string" }, optional: false };
    }
    if (/Temporal\.Instant\.from/.test(source)) {
      return { ...parsed, schema: { ...parsed.schema, format: "date-time" } };
    }
    if (/Temporal\.Duration\.from/.test(source)) {
      return { ...parsed, schema: { ...parsed.schema, format: "duration" } };
    }
    if (/BigInt\(/.test(source)) return parsed;
    return unsupportedSchema(current, context, "Unknown transform");
  }

  if (!isNode(member.object) || member.object.type !== "Identifier" || member.object.name !== "z") {
    return unsupportedSchema(current, context, `Unsupported Zod method ${member.method}`);
  }

  if (member.method === "string") return { schema: { type: "string" }, optional: false };
  if (member.method === "number") return { schema: { type: "number" }, optional: false };
  if (member.method === "boolean") return { schema: { type: "boolean" }, optional: false };
  if (member.method === "bigint") {
    return { schema: { type: "integer", format: "int64" }, optional: false };
  }
  if (member.method === "any" || member.method === "unknown") {
    context.diagnostics.push({
      code: "UNCONSTRAINED_ZOD_SCHEMA",
      message: `${context.sourceSchema} uses z.${member.method}()`,
      severity: "warning",
      location: sourceLocation(context.parsed, current.start),
    });
    return { schema: {}, optional: false };
  }
  if (member.method === "literal") {
    const value = literalValue(member.args[0]);
    if (value === undefined) return unsupportedSchema(current, context, "z.literal is not static");
    const type = value === null ? "null" : typeof value;
    return { schema: { type, const: value }, optional: false };
  }
  if (member.method === "array") {
    if (!isNode(member.args[0])) return unsupportedSchema(current, context, "z.array has no item");
    return {
      schema: { type: "array", items: parseZod(member.args[0], context).schema },
      optional: false,
    };
  }
  if (member.method === "record") {
    const value = member.args.length > 1 ? member.args[1] : member.args[0];
    if (!isNode(value)) return unsupportedSchema(current, context, "z.record has no value schema");
    return {
      schema: {
        type: "object",
        additionalProperties: parseZod(value, context).schema,
      },
      optional: false,
    };
  }
  if (member.method === "object") {
    if (!isNode(member.args[0]))
      return unsupportedSchema(current, context, "z.object has no shape");
    return parseObject(member.args[0], context);
  }
  if (member.method === "union") {
    const values = member.args[0];
    if (!isNode(values) || values.type !== "ArrayExpression") {
      return unsupportedSchema(current, context, "z.union requires an array literal");
    }
    return {
      schema: {
        anyOf: (values.elements as AstNode[])
          .filter(isNode)
          .map((element) => parseZod(element, context).schema),
      },
      optional: false,
    };
  }
  if (member.method === "discriminatedUnion") {
    const discriminator = literalValue(member.args[0]);
    const values = member.args[1];
    if (typeof discriminator !== "string" || !isNode(values) || values.type !== "ArrayExpression") {
      return unsupportedSchema(current, context, "z.discriminatedUnion requires static arguments");
    }
    return {
      schema: {
        oneOf: (values.elements as AstNode[])
          .filter(isNode)
          .map((element) => parseZod(element, context).schema),
        discriminator: { propertyName: discriminator },
      },
      optional: false,
    };
  }
  if (member.method === "lazy") {
    const callback = member.args[0];
    if (
      !isNode(callback) ||
      callback.type !== "ArrowFunctionExpression" ||
      !isNode(callback.body)
    ) {
      return unsupportedSchema(current, context, "z.lazy requires an expression callback");
    }
    const target = identifierName(callback.body);
    if (
      !target ||
      (!context.definitions.has(target) &&
        !/^(?:marshal|unmarshal)[A-Za-z0-9]+Schema$/.test(target))
    ) {
      return unsupportedSchema(current, context, "z.lazy target is not a generated schema");
    }
    return {
      schema: { $ref: `#/components/schemas/${canonicalSchemaName(target)}` },
      optional: false,
    };
  }
  if (member.method === "enum") {
    const values = member.args[0];
    if (!isNode(values) || values.type !== "ArrayExpression") {
      return unsupportedSchema(current, context, "z.enum requires an array literal");
    }
    return {
      schema: {
        type: "string",
        enum: (values.elements as AstNode[]).filter(isNode).map(literalValue),
      },
      optional: false,
    };
  }
  if (member.method === "nativeEnum") {
    const name = identifierName(member.args[0]);
    const values = name ? context.enums.get(name) : undefined;
    if (!values) return unsupportedSchema(current, context, "z.nativeEnum target is not static");
    return { schema: { type: "string", enum: values }, optional: false };
  }

  return unsupportedSchema(current, context, `Unsupported z.${member.method} call`);
}

function baseObjectExpression(node: AstNode): AstNode | undefined {
  let current = unwrapChain(node);
  while (true) {
    const member = callMember(current);
    if (!member || !MODIFIER_METHODS.has(member.method)) break;
    current = unwrapChain(member.object);
  }
  const member = callMember(current);
  if (
    member?.method === "object" &&
    isNode(member.object) &&
    member.object.type === "Identifier" &&
    member.object.name === "z"
  ) {
    return member.args[0];
  }
  return undefined;
}

function transformCallback(node: AstNode): AstNode | undefined {
  const member = callMember(node);
  if (member?.method !== "transform") return undefined;
  const callback = member.args[0];
  return isNode(callback) && callback.type === "ArrowFunctionExpression" ? callback : undefined;
}

function transformedObject(callback: AstNode): AstNode | undefined {
  if (!isNode(callback.body)) return undefined;
  const body = unwrapChain(callback.body);
  if (body.type === "ObjectExpression") return body;
  if (body.type !== "BlockStatement") return undefined;
  const returns: AstNode[] = [];
  walk(body, (node) => {
    if (node.type === "ReturnStatement" && isNode(node.argument)) returns.push(node.argument);
  });
  return returns.length === 1 ? unwrapChain(returns[0] as AstNode) : undefined;
}

function outputProperty(
  property: AstNode,
  inputSchema: WireSchema,
  parameterName: string,
  context: SchemaContext,
): { wireName: string; sdkName: string; schema: WireSchema } | undefined {
  const wireName = propertyName(property);
  if (!wireName || !isNode(property.value)) return undefined;
  const path = memberPath(property.value, parameterName)?.split(".").filter(Boolean);
  if (!path || path.length === 0) {
    unsupportedSchema(property, context, "Marshal output must read the transform input");
    return undefined;
  }
  const schema = schemaAtPath(inputSchema, path);
  if (!schema) {
    unsupportedSchema(property, context, `Marshal output path ${path.join(".")} is unresolved`);
    return undefined;
  }
  return { wireName, sdkName: path[0] as string, schema };
}

function marshalTransform(
  definition: SchemaDefinition,
  context: SchemaContext,
): { schema: WireSchema; sdkToWire: Record<string, string> } | undefined {
  const object = baseObjectExpression(definition.initializer);
  const callback = transformCallback(definition.initializer);
  const output = callback ? transformedObject(callback) : undefined;
  const parameterName = callback ? identifierName((callback.params as AstNode[])?.[0]) : undefined;
  if (!object || !callback || !output || !parameterName) return undefined;

  const inputSchema = parseObject(object, context).schema;
  const properties: Record<string, WireSchema> = {};
  const required: string[] = [];
  const sdkToWire: Record<string, string> = {};
  const inputRequired = new Set((inputSchema.required as string[] | undefined) ?? []);

  const add = (property: AstNode, conditional: boolean): void => {
    if (property.type !== "Property") {
      unsupportedSchema(property, context, "Marshal output object contains a non-property");
      return;
    }
    const extracted = outputProperty(property, inputSchema, parameterName, context);
    if (!extracted) return;
    properties[extracted.wireName] = extracted.schema;
    sdkToWire[extracted.sdkName] = extracted.wireName;
    if (!conditional && inputRequired.has(extracted.sdkName)) required.push(extracted.wireName);
  };

  for (const property of output.properties as AstNode[]) {
    if (!isNode(property)) continue;
    if (property.type === "Property") {
      add(property, false);
      continue;
    }
    if (property.type === "SpreadElement" && isNode(property.argument)) {
      const expression = unwrapChain(property.argument);
      if (
        expression.type === "LogicalExpression" &&
        expression.operator === "&&" &&
        isNode(expression.right) &&
        expression.right.type === "ObjectExpression"
      ) {
        for (const conditionalProperty of expression.right.properties as AstNode[]) {
          if (isNode(conditionalProperty)) add(conditionalProperty, true);
        }
        continue;
      }
    }
    unsupportedSchema(property, context, "Unsupported marshal output spread");
  }

  const schema: WireSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = [...new Set(required)].sort();
  return { schema, sdkToWire };
}

function references(schema: WireSchema): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/components/schemas/")) {
      found.add(record.$ref.slice("#/components/schemas/".length));
    }
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return [...found];
}

function definitionForCanonical(
  canonicalName: string,
  definitions: Map<string, SchemaDefinition>,
): SchemaDefinition | undefined {
  return (
    definitions.get(`unmarshal${canonicalName}Schema`) ??
    definitions.get(`marshal${canonicalName}Schema`) ??
    [...definitions.values()].find((item) => item.canonicalName === canonicalName)
  );
}

function extractSchemas(
  parsed: ParsedSource,
  roots: string[],
  diagnostics: ExtractionDiagnostic[],
): Map<string, WireComponent> {
  const { definitions, enums } = collectSchemaDefinitions(parsed);
  const schemas = new Map<string, WireComponent>();
  const queue = roots.map(canonicalSchemaName);

  while (queue.length > 0) {
    const canonicalName = queue.shift() as string;
    if (schemas.has(canonicalName)) continue;
    if (canonicalName === "BinaryRequest") {
      schemas.set(canonicalName, {
        name: canonicalName,
        schema: { type: "string", format: "binary" },
        sdkToWire: {},
        sourceSchema: "raw request body",
        location: sourceLocation(parsed, 0),
      });
      continue;
    }
    const definition = definitionForCanonical(canonicalName, definitions);
    if (!definition) {
      diagnostics.push({
        code: "MISSING_ZOD_SCHEMA",
        message: `Referenced schema ${canonicalName} has no generated definition`,
        severity: "error",
        location: sourceLocation(parsed, 0),
      });
      continue;
    }
    const context: SchemaContext = {
      parsed,
      definitions,
      enums,
      diagnostics,
      sourceSchema: definition.name,
    };

    let schema: WireSchema;
    let sdkToWire: Record<string, string> = {};
    if (definition.name.startsWith("marshal")) {
      const transformed = marshalTransform(definition, context);
      if (transformed) {
        schema = transformed.schema;
        sdkToWire = transformed.sdkToWire;
      } else {
        schema = parseZod(definition.initializer, context).schema;
      }
    } else {
      schema = parseZod(definition.initializer, context).schema;
      const marshal = definitions.get(`marshal${canonicalName}Schema`);
      if (marshal) {
        const mappingContext: SchemaContext = {
          ...context,
          sourceSchema: marshal.name,
        };
        sdkToWire = marshalTransform(marshal, mappingContext)?.sdkToWire ?? {};
      }
    }

    if (Object.keys(sdkToWire).length === 0 && schema.type === "object") {
      for (const name of Object.keys((schema.properties as Record<string, unknown>) ?? {})) {
        sdkToWire[name] = name;
      }
    }
    schemas.set(canonicalName, {
      name: canonicalName,
      schema,
      sdkToWire,
      sourceSchema: definition.name,
      location: definition.location,
    });
    queue.push(...references(schema).filter((name) => !schemas.has(name)));
  }
  return schemas;
}

/** Parse generated client and model modules without evaluating either module. */
export function extractSdkSources(options: {
  input: DatabricksSdkInput;
  packageVersion: string;
  apiVersion?: string;
  clientSource: string;
  modelSource: string;
  modelDeclarationSource?: string;
  clientFile?: string;
  modelFile?: string;
  modelDeclarationFile?: string;
  strict?: boolean;
}): DatabricksApiIr {
  const apiVersion = options.apiVersion ?? "v1";
  const clientFile = options.clientFile ?? `dist/${apiVersion}/client.js`;
  const modelFile = options.modelFile ?? `dist/${apiVersion}/model.js`;
  const client = parseSource(clientFile, options.clientSource);
  const model = parseSource(modelFile, options.modelSource);
  const modelDeclaration = options.modelDeclarationSource
    ? parseSource(
        options.modelDeclarationFile ?? `dist/${apiVersion}/model.d.ts`,
        options.modelDeclarationSource,
      )
    : undefined;
  const diagnostics: ExtractionDiagnostic[] = [];
  const extracted = extractOperations(client, diagnostics);
  if (modelDeclaration) applyDeclarationResourcePaths(extracted.operations, modelDeclaration);
  const roots = extracted.operations.flatMap((operation) => [
    ...[operation.body?.schemaName, operation.response.schemaName].filter(
      (name): name is string => name !== undefined,
    ),
    ...(operation.response.inlineSchema ? references(operation.response.inlineSchema) : []),
  ]);
  const schemas = extractSchemas(model, roots, diagnostics);

  if (
    options.input.expectedOperations !== undefined &&
    extracted.operations.length !== options.input.expectedOperations
  ) {
    diagnostics.push({
      code: "OPERATION_COUNT_MISMATCH",
      message: `Expected ${options.input.expectedOperations} operations but extracted ${extracted.operations.length}`,
      severity: "error",
      location: sourceLocation(client, 0),
    });
  }
  if (
    options.strict !== false &&
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DatabricksOpenapiError(
      `Strict SDK extraction failed for ${options.input.package}`,
      diagnostics,
    );
  }

  return {
    source: {
      packageName: options.input.package,
      packageVersion: options.packageVersion,
      sdkEntrypoint: `${options.input.package}/${apiVersion}`,
    },
    service: {
      name: extracted.serviceName,
      clientClass: extracted.clientClass,
      scope: "workspace",
    },
    operations: extracted.operations,
    schemas,
    diagnostics,
  };
}

/** Extract one already-resolved SDK package from its generated v1 modules. */
export function extractResolvedSdk(resolved: ResolvedSdkInput, strict = true): DatabricksApiIr {
  return extractSdkSources({
    input: resolved.input,
    packageVersion: resolved.packageVersion,
    apiVersion: resolved.apiVersion,
    clientSource: readFileSync(resolved.clientPath, "utf8"),
    modelSource: readFileSync(resolved.modelPath, "utf8"),
    modelDeclarationSource: readFileSync(resolved.modelDeclarationPath, "utf8"),
    clientFile: `${resolved.input.package}/${resolved.apiVersion}/client.js`,
    modelFile: `${resolved.input.package}/${resolved.apiVersion}/model.js`,
    modelDeclarationFile: `${resolved.input.package}/${resolved.apiVersion}/model.d.ts`,
    strict,
  });
}
