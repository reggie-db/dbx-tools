/**
 * Zod `.describe()` is the documentation owner for schema-backed public types.
 * TypeDoc and the source-doc check both consume this helper so field and schema
 * prose does not have to be duplicated as JSDoc.
 *
 * @module
 */

import { z } from "zod";

/**
 * Return the string passed to the nearest `.describe(...)` in a call chain.
 *
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").Expression | undefined} expression
 */
export function zodDescribeFromExpression(ts, expression) {
  let current = expression;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "describe" &&
      current.arguments[0]
    ) {
      const argument = current.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        const text = argument.text.trim();
        if (text) return text;
      }
    }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      current = current.expression.expression;
      continue;
    }
    if (ts.isCallExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return "";
}

/**
 * Resolve `z.infer<typeof Schema>`, `z.input<typeof Schema>`, or
 * `z.output<typeof Schema>` to the schema identifier.
 *
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").TypeNode | undefined} typeNode
 */
export function schemaNameFromInferType(ts, typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !typeNode.typeArguments?.[0]) return "";
  const typeName = typeNode.typeName;
  const helper = ts.isIdentifier(typeName)
    ? typeName.text
    : ts.isQualifiedName(typeName)
      ? typeName.right.text
      : "";
  if (helper !== "infer" && helper !== "input" && helper !== "output") return "";
  const argument = typeNode.typeArguments[0];
  if (!ts.isTypeQueryNode(argument)) return "";
  const queried = argument.exprName;
  return ts.isIdentifier(queried) ? queried.text : "";
}

/**
 * Find the initializer of a same-file schema constant.
 *
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").SourceFile} source
 * @param {string} schemaName
 */
export function schemaInitializer(ts, source, schemaName) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === schemaName) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

/**
 * Documentation text owned by a public declaration's Zod schema, if any.
 *
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").Declaration} declaration
 */
export function zodDocumentationForDeclaration(ts, declaration) {
  if (ts.isVariableDeclaration(declaration)) {
    return zodDescribeFromExpression(ts, declaration.initializer);
  }
  if (!ts.isTypeAliasDeclaration(declaration)) return "";
  const schemaName = schemaNameFromInferType(ts, declaration.type);
  if (!schemaName) return "";
  return zodDescribeFromExpression(ts, schemaInitializer(ts, declaration.getSourceFile(), schemaName));
}

/**
 * True when a runtime export is a Zod schema instance.
 *
 * @param {unknown} value
 */
export function isZodSchema(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.safeParse === "function" &&
    typeof value.parse === "function"
  );
}

/**
 * Flatten JSON Schema property descriptions into markdown bullets.
 *
 * @param {Record<string, unknown>} schema
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function jsonSchemaFieldLines(schema, prefix = "") {
  if (!schema || typeof schema !== "object") return [];
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : undefined;
  if (!properties) {
    if (Array.isArray(schema.anyOf)) {
      return schema.anyOf.flatMap((entry) => jsonSchemaFieldLines(entry, prefix));
    }
    return [];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lines = [];
  for (const [key, property] of Object.entries(properties)) {
    if (!property || typeof property !== "object") continue;
    const name = prefix ? `${prefix}.${key}` : key;
    const optional = required.has(key) ? "" : " (optional)";
    const description = typeof property.description === "string" ? property.description.trim() : "";
    if (description) lines.push(`- \`${name}\`${optional}: ${description}`);
    lines.push(...jsonSchemaFieldLines(property, name));
  }
  return lines;
}

/**
 * Markdown section TypeDoc pages receive for one schema export.
 *
 * @param {unknown} schema
 * @param {string} exportName
 */
export function schemaDocsMarkdown(schema, exportName) {
  if (!isZodSchema(schema)) return "";
  const json = z.toJSONSchema(schema);
  const description = typeof json.description === "string" ? json.description.trim() : "";
  const fields = jsonSchemaFieldLines(json);
  if (!description && fields.length === 0) return "";
  const heading = exportName.endsWith("Schema")
    ? exportName.slice(0, -"Schema".length)
    : exportName;
  const parts = [`## ${heading} fields`];
  if (description) parts.push("", description);
  if (fields.length > 0) parts.push("", ...fields);
  return parts.join("\n");
}

/**
 * Insert Zod-owned descriptions into a TypeDoc markdown page when missing.
 *
 * @param {string} markdown
 * @param {string} section
 */
export function injectSchemaSection(markdown, section) {
  if (!section) return markdown;
  const heading = section.split("\n", 1)[0];
  if (!heading || markdown.includes(heading)) return markdown;
  return `${markdown.replace(/\s+$/, "")}\n\n${section}\n`;
}
