import { z } from "zod";
import { decodeAnnotation, encodeAnnotation } from "./format";
import { QUOTE_PLUGIN_ID, quotePluginIdSchema } from "./quote-identity";
import { acceptedQuoteSourceTitles, describeError, LocalizedError, text, type LocaleSource } from "./messages";

const callable = z.custom<(...args: unknown[]) => unknown>((value) => typeof value === "function");
const schema = z.object({ safeParse: callable });
const quoteId = z.string().uuid().brand<"QuoteId">();
export type QuoteId = z.infer<typeof quoteId>;
export const QUOTE_SOURCE = "selection-v1";
export const quoteAttachmentSchema = z.object({
  kind: z.literal("plugin_resource"),
  pluginId: quotePluginIdSchema,
  sourceId: z.literal(QUOTE_SOURCE),
  sourceTitle: z.string().refine((value) => acceptedQuoteSourceTitles.includes(value)),
  sourceIcon: z.literal("MessageSquareQuote"),
  item: z.object({
    id: quoteId,
    identifier: z.string(),
    title: z.string(),
    url: z.string().url(),
    text: z.string(),
    subtitle: z.string().optional(),
    resourceType: z.literal("quote"),
  }).passthrough(),
}).passthrough();
export type QuoteAttachment = z.infer<typeof quoteAttachmentSchema>;
const inputSchema = z.object({ text: z.string(), attachments: z.array(z.unknown()), cwd: z.string().optional() }).passthrough();
export type DraftInput = z.infer<typeof inputSchema>;
const stateSchema = z.object({
  getDraftInput: callable,
  hydrateDraftInput: callable,
  saveDraftInput: callable,
});
function properties(value: unknown, names: string[]): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  return Object.fromEntries(names.map((name) => [name, Reflect.get(value, name)]));
}
const storeSchema = z.preprocess((value) => properties(value, ["getState", "subscribe"]), z.object({ getState: callable, subscribe: callable }));
const sessionSchema = z.object({
  sessions: z.record(z.string(), z.unknown()),
});
const agentMap = z.custom<ReadonlyMap<unknown, unknown>>((value) => value instanceof Map);
const directorySchema = z.object({ agents: agentMap, agentDetails: agentMap });
export interface ComposerBinding {
  readonly hostId: string;
  readonly workspacePath: string;
  readonly agentId: string;
  readonly pane: HTMLElement;
  readonly anchor: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly wrapper: HTMLElement;
  readonly card: HTMLElement | null;
}
export interface StoreBinding {
  readonly kind: "store";
  readonly hostId: string;
  readonly agentId: string;
  readonly draftKey: string;
  readonly anchor: HTMLElement;
  readonly pane: HTMLElement;
  readonly label: string;
  readonly validate: () => boolean;
}
export type DraftBinding = ComposerBinding | StoreBinding;
export function isStoreBinding(binding: DraftBinding): binding is StoreBinding { return "kind" in binding && binding.kind === "store"; }
export function bindingElement(binding: DraftBinding): HTMLElement { return isStoreBinding(binding) ? binding.anchor : binding.input; }
export function bindingCard(binding: DraftBinding): HTMLElement | null { return isStoreBinding(binding) ? null : binding.card; }
export interface QuoteRef {
  readonly id: QuoteId;
  readonly binding: DraftBinding;
}
export type WriteOutcome =
  | { kind: "committed" }
  | { kind: "not-written"; reason: string; fallback: boolean }
  | { kind: "uncertain"; reason: string };
export interface DraftHost {
  key(hostId: string, agentId: string): string;
  hasAgent(hostId: string, agentId: string): boolean;
  hydrate(key: string): Promise<void>;
  read(key: string): DraftInput | undefined;
  save(key: string, input: DraftInput): void;
  flush(): Promise<void>;
  subscribe(listener: () => void): () => void;
  validateAttachment(attachment: QuoteAttachment): void;
}

export function makeQuote(content: string, title: string, url: string, language?: LocaleSource): QuoteAttachment {
  const id = quoteId.parse(crypto.randomUUID());
  return quoteAttachmentSchema.parse({
    kind: "plugin_resource", pluginId: QUOTE_PLUGIN_ID, sourceId: QUOTE_SOURCE,
    sourceTitle: text(language).quoteSourceTitle, sourceIcon: "MessageSquareQuote",
    item: { id, identifier: `quote-${id}`, title: title.trim().slice(0, 64) || text(language).quoteSnippet, url, text: content, resourceType: "quote" },
  });
}

export function readQuotes(input: DraftInput | undefined): QuoteAttachment[] {
  return (input?.attachments ?? []).flatMap((value) => {
    const parsed = quoteAttachmentSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function currentHostId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/h\/([^/]+)\/workspace\//);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

const PANE = '[data-testid^="workspace-pane-"]';
const INPUT = "textarea[data-composer-input]";
const TAB = '[data-testid^="workspace-tab-agent_"][aria-selected="true"]';
const TAB_PREFIX = "workspace-tab-agent_";
function visible(element: Element): boolean { return element.getClientRects().length > 0; }
function nearestUnique(from: HTMLElement, selector: string): Element | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    const found = Array.from(node.querySelectorAll(selector)).filter(visible);
    if (found.length === 1) return found[0];
    if (found.length > 1 || node.matches(PANE)) return null;
  }
  return null;
}
export function composerCard(input: HTMLTextAreaElement): HTMLElement | null {
  const root = input.closest('[data-testid="message-input-root"]');
  if (!root) return null;
  for (let node = input.parentElement; node && node !== root; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display !== "flex" || style.flexDirection !== "column" || parseFloat(style.borderTopWidth) <= 0
      || !Number.isFinite(parseFloat(style.borderTopWidth)) || parseFloat(style.borderRadius) <= 0) continue;
    if (node.querySelectorAll(INPUT).length !== 1 || ["transparent", "rgba(0, 0, 0, 0)"].includes(style.backgroundColor)) return null;
    return node;
  }
  return null;
}
export function bindComposer(input: unknown, anchor: unknown, agentId: string): ComposerBinding | null {
  if (!(input instanceof HTMLTextAreaElement) || !(anchor instanceof HTMLElement)) return null;
  const pane = input.closest(PANE);
  const root = input.closest('[data-testid="message-input-root"]');
  const wrapper = root && Array.from(root.children).find((child) => child.contains(input));
  const hostId = currentHostId(window.location.href);
  if (!(pane instanceof HTMLElement) || !(wrapper instanceof HTMLElement) || !hostId) return null;
  const transcript = anchor.closest('[data-testid="agent-chat-scroll"]');
  if (!(transcript instanceof HTMLElement)) return null;
  const binding = { hostId, workspacePath: window.location.pathname, agentId, pane, anchor: transcript, input, wrapper, card: composerCard(input) };
  return bindingStatus(binding) !== "scope-changed" ? binding : null;
}
export function bindingStatus(binding: DraftBinding): "ready" | "locked" | "scope-changed" {
  if (isStoreBinding(binding)) {
    try { return binding.validate() ? "ready" : "scope-changed"; } catch { return "scope-changed"; }
  }
  const { input, anchor, pane, wrapper, hostId, agentId } = binding;
  const transcript = anchor.closest('[data-testid="agent-chat-scroll"]');
  if (!input.isConnected || !anchor.isConnected || !pane.isConnected || !wrapper.contains(input)
    || !visible(input) || input.closest(PANE) !== pane || anchor.closest(PANE) !== pane
    || currentHostId(window.location.href) !== hostId || window.location.pathname !== binding.workspacePath || !(transcript instanceof HTMLElement)
    || nearestUnique(transcript, INPUT) !== input
    || nearestUnique(transcript, TAB)?.getAttribute("data-testid") !== `${TAB_PREFIX}${agentId}`) return "scope-changed";
  if (input.disabled || input.readOnly || wrapper.closest('[aria-busy="true"]')
    || window.getComputedStyle(wrapper).pointerEvents === "none") return "locked";
  return "ready";
}

export async function mutateQuotes(options: {
  language?: LocaleSource;
  host: DraftHost;
  binding: DraftBinding;
  change: { kind: "add"; attachment: QuoteAttachment } | { kind: "remove"; id: QuoteId };
  isCurrent?: () => boolean;
}): Promise<WriteOutcome> {
  const { host, binding, change } = options;
  const t = text(options.language);
  const valid = () => (options.isCurrent?.() ?? true) && bindingStatus(binding) === "ready"
    && host.hasAgent(binding.hostId, binding.agentId);
  let key: string;
  let next: DraftInput;
  let matches: (value: unknown) => boolean;
  try {
    if (!valid()) return { kind: "not-written", reason: t.composerLocked, fallback: false };
    key = host.key(binding.hostId, binding.agentId);
    if (isStoreBinding(binding) && key !== binding.draftKey) return { kind: "not-written", reason: t.recipientIdentityChanged, fallback: false };
    await host.hydrate(key);
    if (!valid()) return { kind: "not-written", reason: t.composerLocked, fallback: false };
    const previous = host.read(key);
    const current = previous ?? { text: isStoreBinding(binding) ? "" : binding.input.value, attachments: [] };
    if (change.kind === "add") host.validateAttachment(change.attachment);
    matches = (value: unknown) => {
      const parsed = quoteAttachmentSchema.safeParse(value);
      return parsed.success && parsed.data.item.id === (change.kind === "add" ? change.attachment.item.id : change.id);
    };
    const present = current.attachments.some(matches);
    if (present === (change.kind === "add")) {
      try { await host.flush(); } catch { return { kind: "uncertain", reason: t.annotationSaveUnconfirmed }; }
      return valid() ? { kind: "committed" } : { kind: "uncertain", reason: t.chatSwitchedCheck };
    }
    const attachments = change.kind === "add"
      ? [...current.attachments, change.attachment]
      : current.attachments.filter((value) => !matches(value));
    next = { ...current, attachments };
    if (!valid()) return { kind: "not-written", reason: t.chatSwitchedNotSaved, fallback: false };
  } catch (cause) {
    return { kind: "not-written", reason: reason(cause, options.language), fallback: !isStoreBinding(binding) };
  }
  try {
    host.save(key, next);
    const saved = host.read(key);
    if (!saved || saved.attachments.some(matches) !== (change.kind === "add")) {
      return { kind: "uncertain", reason: t.quoteSaveUnconfirmed };
    }
  } catch {
    return { kind: "uncertain", reason: t.quoteSaveUnconfirmed };
  }
  try {
    await host.flush();
    if (!valid()) return { kind: "uncertain", reason: t.chatSwitchedQuoteKept };
    return { kind: "committed" };
  } catch {
    return { kind: "uncertain", reason: t.quoteDraftUnconfirmed };
  }
}

export function writeQuoteComment(options: {
  language?: LocaleSource;
  host: DraftHost;
  ref: QuoteRef;
  comment: string;
  isCurrent?: () => boolean;
}): WriteOutcome {
  const { host, ref, comment } = options;
  const t = text(options.language);
  const { binding, id } = ref;
  let key: string;
  let next: DraftInput;
  try {
    if (!(options.isCurrent?.() ?? true) || bindingStatus(binding) !== "ready" || !host.hasAgent(binding.hostId, binding.agentId)) {
      return { kind: "not-written", reason: t.commentChatSwitched, fallback: false };
    }
    key = host.key(binding.hostId, binding.agentId);
    if (isStoreBinding(binding) && key !== binding.draftKey) return { kind: "not-written", reason: t.recipientIdentityChanged, fallback: false };
    const current = host.read(key);
    const index = current?.attachments.findIndex((value) => {
      const parsed = quoteAttachmentSchema.safeParse(value);
      return parsed.success && parsed.data.item.id === id;
    }) ?? -1;
    if (!current || index < 0) return { kind: "not-written", reason: t.quoteGone, fallback: false };
    const attachment = quoteAttachmentSchema.parse(current.attachments[index]);
    const decoded = decodeAnnotation(attachment.item, options.language);
    if (decoded.kind === "invalid") return { kind: "not-written", reason: decoded.reason, fallback: false };
    const { subtitle: previousComment, ...item } = attachment.item;
    const updated = { ...attachment, item: { ...item, ...encodeAnnotation({ quote: decoded.annotation.quote, comment }) } };
    host.validateAttachment(updated);
    const attachments = [...current.attachments];
    attachments[index] = updated;
    next = { ...current, attachments };
    if (!(options.isCurrent?.() ?? true) || bindingStatus(binding) !== "ready") return { kind: "not-written", reason: t.recipientSwitchedComment, fallback: false };
  } catch (cause) {
    return { kind: "not-written", reason: reason(cause, options.language), fallback: false };
  }
  try {
    host.save(key, next);
    if (!sameContent(host.read(key), next)) return { kind: "uncertain", reason: t.commentWriteUnconfirmed };
    return { kind: "committed" };
  } catch (cause) {
    return { kind: "uncertain", reason: t.commentWriteUnconfirmedWith(reason(cause, options.language)) };
  }
}

function sameContent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key)
    && sameContent(Reflect.get(left, key), Reflect.get(right, key)));
}

export function reason(cause: unknown, language?: LocaleSource): string { return describeError(cause, language); }

export function resolveModuleIds(source: string, signatures: Record<string, readonly string[]>, language?: LocaleSource): Record<string, number> {
  const chunks = source.split(/(?=__d\(function\()/);
  const result: Record<string, number> = {};
  for (const [name, exports] of Object.entries(signatures)) {
    const matching = chunks.flatMap((chunk) => {
      if (!chunk.startsWith("__d(function(")) return [];
      if (!exports.every((entry) => new RegExp(`(?:Object\\.defineProperty\\([^,]+,["']${entry}["']|\\.${entry}\\s*=)`).test(chunk))) return [];
      const match = chunk.match(/\},(\d+),\[[\d,]*\]\);/);
      return match ? [Number(match[1])] : [];
    });
    if (matching.length !== 1) throw new LocalizedError((m) => m.moduleContractUnclear(name), language);
    result[name] = matching[0];
  }
  return result;
}
export const MODULE_SIGNATURES = {
  store: ["useDraftStore", "flushDraftPersistStorage"],
  draft: ["CanonicalDraftInputSchema", "editDraftRecordText"],
  keys: ["buildDraftStoreKey", "buildNewWorkspaceDraftKey"],
  attachment: ["createPluginResourceAttachment", "togglePluginResourceAttachment", "pluginResourceAttachmentToAgentAttachment"],
  sessions: ["useSessionStore", "normalizeWorkspaceDescriptor"],
};
const parseResultSchema = z.discriminatedUnion("success", [z.object({ success: z.literal(true), data: z.unknown() }), z.object({ success: z.literal(false) })]);
function hostParse(contract: z.infer<typeof schema>, value: unknown, language?: LocaleSource): unknown {
  const result = parseResultSchema.parse(contract.safeParse(value));
  if (!result.success) throw new LocalizedError((m) => m.draftFormatChanged, language);
  return result.data;
}

export function createDraftHost(requireModule: (id: number) => unknown, ids: Record<string, number>, language?: LocaleSource): DraftHost {
  const t = () => text(language);
  const module = z.object({ useDraftStore: storeSchema, flushDraftPersistStorage: callable }).parse(requireModule(ids.store));
  const drafts = z.object({ CanonicalDraftInputSchema: schema }).parse(requireModule(ids.draft));
  const keys = z.object({ buildDraftStoreKey: callable }).parse(requireModule(ids.keys));
  const resource = z.object({ PluginResourceComposerAttachmentSchema: schema, pluginResourceAttachmentToAgentAttachment: callable }).parse(requireModule(ids.attachment));
  const sessions = z.object({ useSessionStore: z.preprocess((value) => properties(value, ["getState"]), z.object({ getState: callable })) }).parse(requireModule(ids.sessions));
  const state = () => stateSchema.parse(module.useDraftStore.getState());
  const validateAttachment = (attachment: QuoteAttachment) => {
    const parsed = quoteAttachmentSchema.parse(hostParse(resource.PluginResourceComposerAttachmentSchema, attachment, language));
    if (parsed.item.url !== attachment.item.url || parsed.item.id !== attachment.item.id || parsed.item.subtitle !== attachment.item.subtitle) throw new Error(t().commentNotKept);
    const converted = z.object({ type: z.literal("text"), mimeType: z.literal("text/plain"), text: z.string() }).parse(resource.pluginResourceAttachmentToAgentAttachment(parsed));
    if (converted.text !== attachment.item.text) throw new Error(t().quoteNotKept);
    const canonical = readQuotes(inputSchema.parse(hostParse(drafts.CanonicalDraftInputSchema, { text: "", attachments: [attachment] }, language)))[0];
    if (!canonical || canonical.item.url !== attachment.item.url || canonical.item.id !== attachment.item.id || canonical.item.text !== attachment.item.text || canonical.item.subtitle !== attachment.item.subtitle) {
      throw new Error(t().draftNotKept);
    }
  };
  const probe = makeQuote("> contract check\n> second line", "Quote snippet", "https://paseo.sh/", language);
  validateAttachment(probe);
  validateAttachment({ ...probe, item: { ...probe.item, ...encodeAnnotation({ quote: probe.item.text, comment: "multi-line comment\nsecond line" }) } });
  state();
  return {
    key: (hostId, agentId) => z.string().min(1).parse(keys.buildDraftStoreKey({ serverId: hostId, agentId })),
    hasAgent: (hostId, agentId) => {
      const raw = sessionSchema.parse(sessions.useSessionStore.getState()).sessions[hostId];
      if (!raw) return false;
      const session = directorySchema.parse(raw);
      return session.agents.has(agentId) || session.agentDetails.has(agentId);
    },
    hydrate: async (key) => { await state().hydrateDraftInput({ draftKey: key }); },
    read: (key) => {
      const raw = state().getDraftInput(key);
      if (raw == null) return undefined;
      hostParse(drafts.CanonicalDraftInputSchema, raw, language);
      return inputSchema.parse(raw);
    },
    save: (key, input) => { hostParse(drafts.CanonicalDraftInputSchema, input, language); state().saveDraftInput({ draftKey: key, draft: input }); },
    flush: async () => { await module.flushDraftPersistStorage(); },
    subscribe: (listener) => {
      const unsubscribe = callable.parse(module.useDraftStore.subscribe(listener));
      return () => { unsubscribe(); };
    },
    validateAttachment,
  };
}

export async function discoverDraftHost(signal: AbortSignal, language?: LocaleSource): Promise<DraftHost> {
  const runtime = z.object({ __r: callable }).parse(globalThis);
  const base = new URL(window.location.href);
  const urls = Array.from(document.scripts).flatMap((script) => {
    if (!script.src) return [];
    const url = new URL(script.src, base);
    return url.protocol === base.protocol && url.host === base.host ? [url.href] : [];
  });
  for (const url of urls) {
    const response = await fetch(url, { signal });
    if (!response.ok) continue;
    const source = await response.text();
    if (signal.aborted) throw new LocalizedError((m) => m.quotePluginClosed, language);
    if (!source.includes("flushDraftPersistStorage")) continue;
    const ids = resolveModuleIds(source, MODULE_SIGNATURES, language);
    return createDraftHost((id) => runtime.__r(id), ids, language);
  }
  throw new LocalizedError((m) => m.draftApiNotFound, language);
}
