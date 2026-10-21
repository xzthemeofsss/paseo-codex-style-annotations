import { text, type LocaleSource } from "./messages";

/**
 * Text shaping shared by the selection bar and the side chat. Pure functions:
 * no DOM, no React Native, so both runtimes can import them.
 */

export interface QuoteSource {
  /** Markdown when the host could serialize the selection, rendered text otherwise. */
  text: string;
  /** Set when the whole selection sits inside one code block, code span, or tool output. */
  code: { language: string | null } | null;
}

/**
 * The snippet a quote becomes in the composer.
 *
 * Multi-line code keeps a fence: `>` in front of every line makes code unreadable
 * to the next reader and to the model. A single line of code stays a quote.
 */
export function formatQuote(source: QuoteSource): string {
  const code = source.code;
  // Code keeps its indentation; prose loses the stray spaces a drag picks up.
  const text = code ? normalize(source.text) : normalize(source.text).trim();
  if (code && text.includes("\n")) {
    const fence = text.includes("```") ? "````" : "```";
    return `${fence}${code.language ?? ""}\n${text}\n${fence}`;
  }
  const body = code ? "`" + text.replace(/`/g, "\\`") + "`" : text;
  return body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

export interface Annotation {
  readonly quote: string;
  readonly comment: string;
}

export function encodeAnnotation(annotation: Annotation): { text: string; subtitle?: string } {
  return annotation.comment.length
    ? { text: `${annotation.quote}\n\n${annotation.comment}`, subtitle: annotation.comment }
    : { text: annotation.quote };
}

export function decodeAnnotation(item: { text: string; subtitle?: string }, language?: LocaleSource):
  | { kind: "editable"; annotation: Annotation }
  | { kind: "invalid"; reason: string } {
  if (item.subtitle === undefined) return { kind: "editable", annotation: { quote: item.text, comment: "" } };
  const suffix = `\n\n${item.subtitle}`;
  if (!item.subtitle.length || !item.text.endsWith(suffix)) {
    return { kind: "invalid", reason: text(language).commentFormatUnsafe };
  }
  return { kind: "editable", annotation: { quote: item.text.slice(0, -suffix.length), comment: item.subtitle } };
}

function normalize(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+|\n+$/g, "");
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

const CONTEXT_TURNS = 8;
const TURN_LIMIT = 6_000;
const CONTEXT_LIMIT = 30_000;

/**
 * Instructions for a side chat. The side agent is a fresh session: Paseo cannot
 * fork a conversation, so the recent main-chat turns travel here instead.
 */
export function buildSideChatSystemPrompt(turns: readonly ChatTurn[], quote: string): string {
  const source = findSourceTurn(turns, quote);
  const recent = turns.slice(-CONTEXT_TURNS);
  const picked = source !== null && !recent.includes(turns[source]!) ? [turns[source]!, ...recent] : recent;

  let budget = CONTEXT_LIMIT;
  const rendered: string[] = [];
  for (const turn of [...picked].reverse()) {
    const text = clip(turn.text, TURN_LIMIT);
    if (text.length > budget) break;
    budget -= text.length;
    rendered.unshift(`<${turn.role}>\n${text}\n</${turn.role}>`);
  }

  return [
    "You are a side chat branched off a main conversation in the same workspace.",
    "The user highlighted a passage from that conversation and asks about it here, so the main thread stays focused.",
    "Answer the question about the quoted passage. Keep it conversational and concise.",
    "Do not modify files or run commands that change state unless the user explicitly asks in this side chat.",
    "",
    "Recent turns of the main conversation, oldest first:",
    "<main_conversation>",
    rendered.join("\n\n"),
    "</main_conversation>",
  ].join("\n");
}

/** Index of the turn the quote was taken from, matched on letters and digits only. */
function findSourceTurn(turns: readonly ChatTurn[], quote: string): number | null {
  const needle = squash(quote).slice(0, 80);
  if (needle.length < 8) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (squash(turns[index]!.text).includes(needle)) return index;
  }
  return null;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${trimmed.slice(0, head)}\n[…]\n${trimmed.slice(-tail)}`;
}

/** Short, single-line side chat title from the question. */
export function sideChatTitle(question: string): string {
  const line = question.trim().split("\n")[0] ?? "";
  const short = line.length > 48 ? `${line.slice(0, 47)}…` : line;
  return `Side chat: ${short || "quote"}`;
}
