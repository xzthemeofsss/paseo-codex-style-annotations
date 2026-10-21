import { z } from "zod";
import { decodeAnnotation } from "./format";
import { acceptedSourcePrefixes, text, type LocaleSource } from "./messages";

const name = z.string().min(1).max(2048);
const integer = z.number().int().nonnegative();
const workspace = z.object({ serverId: name, workspaceId: name, workspaceKey: name, root: name }).strict();
const file = z.object({ requestedPath: name, absolutePath: name.nullable(), relativePath: name.nullable() }).strict();
const version = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const point = z.object({ x: integer, y: integer }).strict();
const segment = z.object({ file, side: z.enum(["old", "new"]), lineStart: integer.positive(), lineEnd: integer.positive(), startColumn: integer, endColumn: integer, displayPath: name, oldPath: name.nullable(), cells: z.array(z.object({ lineNumber: integer.positive(), hunkIndex: integer, lineIndex: integer, type: name, from: integer, to: integer }).strict()).min(1).max(512) }).strict().refine((x) => x.lineEnd >= x.lineStart);
export const externalOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), workspace, tabId: name, file, from: integer, to: integer, lineStart: integer.positive(), lineEnd: integer.positive(), version }).strict().refine((x) => x.to > x.from && x.lineEnd >= x.lineStart),
  z.object({ kind: z.literal("markdown"), workspace, tabId: name, file, version }).strict(),
  z.object({ kind: z.literal("terminal"), workspace, tabId: name, terminalId: name, cwd: name, streamKey: name, buffer: z.enum(["normal", "alternate"]), start: point, end: point, cols: integer.positive(), rows: integer.positive(), version }).strict(),
  z.object({ kind: z.literal("diff"), workspace, tabId: name, segment, revision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("commit"), sha: name }).strict(),
    z.object({ kind: z.literal("working"), mode: z.enum(["uncommitted", "base"]), baseRef: name.nullable(), ignoreWhitespace: z.boolean(), revisionResolution: z.literal("unresolved") }).strict(),
  ]), version }).strict(),
]);
export type ExternalOrigin = z.infer<typeof externalOriginSchema>;
export type WorkspaceIdentity = ExternalOrigin["workspace"];
export type FileIdentity = z.infer<typeof file>;
export interface ExternalSnapshot { readonly text: string; readonly title: string; readonly origin: ExternalOrigin }
const envelope = z.object({ v: z.literal(1), origin: externalOriginSchema, prefix: z.string().max(512), suffix: z.string().max(64) }).strict();
const FRAGMENT = "paseo-annotation=";
export const MAX_LOCATOR_LENGTH = 16_384;

export function encodeExternal(snapshot: ExternalSnapshot, sourceUrl: string, language?: LocaleSource): { url: string; text: string } {
  const url = new URL(sourceUrl);
  const source = externalOriginSchema.parse(snapshot.origin);
  const prefix = `${text(language).sourcePrefix}${snapshot.title.slice(0, 128)}\n\n`;
  const suffix = "";
  const fragment = `${FRAGMENT}${encodeURIComponent(JSON.stringify({ v: 1, origin: source, prefix, suffix }))}`;
  if (fragment.length > MAX_LOCATOR_LENGTH) throw new Error(text(language).locatorTooLong);
  url.hash = fragment;
  return { url: url.href, text: prefix + snapshot.text + suffix };
}

export function decodeExternal(item: { url: string; text: string; subtitle?: string }, language?: LocaleSource):
  | { kind: "legacy" }
  | { kind: "invalid"; reason: string }
  | { kind: "external"; snapshot: ExternalSnapshot; comment: string } {
  let url: URL;
  try { url = new URL(item.url); } catch { return { kind: "legacy" }; }
  const fragment = url.hash.slice(1);
  if (!fragment.startsWith(FRAGMENT)) return { kind: "legacy" };
  try {
    if (fragment.length > MAX_LOCATOR_LENGTH) throw new Error("locator too long");
    const data = envelope.parse(JSON.parse(decodeURIComponent(fragment.slice(FRAGMENT.length))));
    const decoded = decodeAnnotation(item, language);
    if (decoded.kind !== "editable") throw new Error(decoded.reason);
    const quote = decoded.annotation.quote;
    if (!quote.startsWith(data.prefix) || !quote.endsWith(data.suffix) || quote.length < data.prefix.length + data.suffix.length) throw new Error("snapshot text mismatch");
    return { kind: "external", snapshot: { text: quote.slice(data.prefix.length, data.suffix ? -data.suffix.length : undefined), title: data.prefix.slice(acceptedSourcePrefixes.find((entry) => data.prefix.startsWith(entry))?.length ?? 0).trimEnd(), origin: data.origin }, comment: decoded.annotation.comment };
  } catch { return { kind: "invalid", reason: text(language).locatorInvalid }; }
}

export function fingerprint(content: string, language?: LocaleSource): Promise<z.infer<typeof version>> {
  if (!globalThis.crypto?.subtle) throw new Error(text(language).fingerprintUnavailable);
  const bytes = new TextEncoder().encode(content);
  return crypto.subtle.digest("SHA-256", bytes).then((hash) => ({ algorithm: "sha256", digest: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") }));
}
