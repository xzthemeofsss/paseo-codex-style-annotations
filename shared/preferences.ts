import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const annotationValuesSchema = z.object({
  chat: z.boolean().default(true),
  file: z.boolean().default(true),
  diff: z.boolean().default(true),
  markdown: z.boolean().default(true),
  terminal: z.boolean().default(true),
}).strict();
export type AnnotationValues = z.infer<typeof annotationValuesSchema>;
export type AnnotationKind = keyof AnnotationValues;
export const preferences = defineSettings({ id: "annotation-kinds", scope: "host", version: 1, schema: annotationValuesSchema });
