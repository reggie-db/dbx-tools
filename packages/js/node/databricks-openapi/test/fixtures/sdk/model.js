import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

const WidgetMode = {
  WIDGET_MODE_UNSPECIFIED: "WIDGET_MODE_UNSPECIFIED",
  ACTIVE: "ACTIVE",
};

const unmarshalWidgetSchema = z
  .object({
    name: z.string(),
    display_name: z.string().optional(),
    created_at: z
      .string()
      .transform((value) => Temporal.Instant.from(value))
      .optional(),
    count: z
      .union([z.number(), z.bigint(), z.string()])
      .transform((value) => BigInt(value))
      .optional(),
    mode: z.nativeEnum(WidgetMode).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    child: z.lazy(() => unmarshalWidgetSchema).optional(),
    payload: z.unknown().optional(),
    kind: z.literal("widget"),
  })
  .transform((data) => ({
    name: data.name,
    displayName: data.display_name,
    createdAt: data.created_at,
    count: data.count,
    mode: data.mode,
    labels: data.labels,
    child: data.child,
    payload: data.payload,
    kind: data.kind,
  }));

const marshalWidgetSchema = z
  .object({
    name: z.string(),
    displayName: z.string().optional(),
    createdAt: z
      .any()
      .transform((value) => value.toString())
      .optional(),
    count: z.bigint().optional(),
    mode: z.nativeEnum(WidgetMode).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    child: z.lazy(() => marshalWidgetSchema).optional(),
    payload: z.any().optional(),
    kind: z.literal("widget"),
  })
  .transform((data) => ({
    name: data.name,
    display_name: data.displayName,
    created_at: data.createdAt,
    count: data.count,
    mode: data.mode,
    labels: data.labels,
    child: data.child,
    payload: data.payload,
    kind: data.kind,
  }));

const marshalUploadRequestSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    source: z
      .discriminatedUnion("$case", [
        z.object({ $case: z.literal("inline"), inline: z.string() }),
        z.object({ $case: z.literal("uri"), uri: z.string() }),
      ])
      .optional(),
  })
  .transform((data) => ({
    name: data.name,
    content_bytes: data.content,
    metadata: data.metadata,
    ...(data.source?.$case === "inline" && { inline: data.source.inline }),
    ...(data.source?.$case === "uri" && { uri: data.source.uri }),
  }));

export { WidgetMode, marshalUploadRequestSchema, marshalWidgetSchema, unmarshalWidgetSchema };
