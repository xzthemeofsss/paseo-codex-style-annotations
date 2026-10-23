import { z } from "zod";
import { ANNOTATION_ICON, annotationPalette } from "./annotation-visuals";
import { discoverSentNative, type SentNative } from "./sent-native";
import { quotePluginIdSchema } from "./quote-identity";
import type { InstallationOwner } from "./host-draft-bridge";

const NATIVE = '[data-testid="user-message"]';
const OWNED = "data-paseo-sent-quotes";
const HIDDEN = "data-paseo-sent-quote-hidden";
const propsSchema = z.object({ serverId: z.string().min(1), agentId: z.string().min(1), messageId: z.string().min(1).optional(),
  message: z.string(), images: z.array(z.unknown()).default([]), attachments: z.array(z.unknown()).default([]), isPending: z.boolean().default(false) });
const quoteSchema = z.object({ type: z.literal("text"), mimeType: z.literal("text/plain"), text: z.string(),
  externalResource: z.object({ provider: quotePluginIdSchema, resourceType: z.literal("quote"), id: z.string().uuid(),
    identifier: z.string(), title: z.string(), providerLabel: z.string() }) }).refine((item) => item.externalResource.identifier === `quote-${item.externalResource.id}`);
const fiberSchema = z.object({ tag: z.number().int(), child: z.unknown(), sibling: z.unknown(), return: z.unknown(),
  stateNode: z.unknown(), elementType: z.unknown(), memoizedProps: z.unknown(), memoizedState: z.unknown() });
type Fiber = z.infer<typeof fiberSchema>;
function isFiber(value: unknown): value is Fiber {
  return typeof value === "object" && value !== null &&
    ["child", "sibling", "return", "stateNode", "elementType", "memoizedProps", "memoizedState"].every((key) => key in value) && fiberSchema.safeParse(value).success;
}
type Root = { current: unknown };
type Quote = Readonly<{ id: string; title: string; text: string }>;
type SentRowIdentity = Readonly<{ kind: "provisional"; localId: string }> | Readonly<{ kind: "canonical"; messageId: string }>;
type SentRow = Readonly<{ serverId: string; agentId: string; row: HTMLElement; localId: string; identity: SentRowIdentity; pending: boolean; native: HTMLElement; slot: HTMLElement; labelText: HTMLElement;
  quotes: readonly Quote[]; frames: readonly HTMLElement[]; rootOnly: boolean; content: string; root: Root; current: unknown }>;
type Override = Readonly<{ element: HTMLElement; value: string; priority: string; token: string }>;
type Decoration = { row: SentRow; element: HTMLDivElement; popup: HTMLDivElement; button: HTMLButtonElement; panel: HTMLDivElement;
  expanded: boolean; overrides: readonly Override[]; close(): void };

const CSS = `
:host{font:12px/1.45 var(--quote-font,system-ui,sans-serif);color:var(--quote-fg)}*{box-sizing:border-box}
button{font:inherit;color:inherit;cursor:pointer}.chip{height:29px;display:inline-flex;align-items:center;gap:5px;padding:0 10px;border:1px solid var(--quote-border);border-radius:999px;background:var(--quote-chip);color:var(--quote-muted);white-space:nowrap}
button:hover{background:var(--quote-hover)}button:focus-visible{outline:2px solid var(--quote-muted);outline-offset:2px}
.panel{position:fixed;z-index:2147482999;border:1px solid var(--quote-border);border-radius:12px;background:var(--quote-bg);box-shadow:0 12px 36px #0004;overflow:auto;overscroll-behavior:contain;user-select:text;-webkit-user-select:text}
.panel[hidden]{display:none}header{padding:10px 12px;font-weight:600}.entry{padding:11px 12px;border-top:1px solid var(--quote-border)}
.entry-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--quote-muted)}.entry-head>span{min-width:0;overflow-wrap:anywhere}.copy{flex-shrink:0;white-space:nowrap;border:0;border-radius:5px;background:transparent;padding:3px 6px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0 0;user-select:text;-webkit-user-select:text}
`;

export function installSentQuotes(options: { owner: InstallationOwner; discover?: (signal: AbortSignal) => Promise<SentNative> }): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  const doc = document, view = window;
  const lifetime = new AbortController();
  const decorations = new Map<HTMLElement, Decoration>();
  const relinquished = new WeakSet<HTMLElement>();
  const isElement = (value: unknown): value is HTMLElement => value instanceof view.HTMLElement;
  let capability: SentNative | undefined;
  let disposed = false;
  let scheduled = false;

  function rootFor(native: HTMLElement): Root | undefined {
    const keys = Object.keys(native).filter((key) => key.startsWith("__reactFiber$"));
    if (keys.length !== 1) return;
    let node: unknown = Reflect.get(native, keys[0]);
    const seen = new Set<unknown>();
    while (isFiber(node) && !seen.has(node)) {
      seen.add(node);
      if (node.tag === 3) {
        const root = node.stateNode;
        if (typeof root === "object" && root !== null && "current" in root && isFiber(root.current) && root.current.tag === 3 && root.current.stateNode === root) return root;
        return;
      }
      node = node.return;
    }
  }
  function visible(native: HTMLElement, slot: HTMLElement): boolean {
    if (!native.isConnected || slot.getClientRects().length === 0) return false;
    for (let node: HTMLElement | null = native; node; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      const hiddenByUs = decorations.get(native)?.overrides.some((entry) => entry.element === node && ownsOverride(entry));
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.visibility === "hidden" || style.visibility === "collapse" ||
          (style.display === "none" && !hiddenByUs)) return false;
    }
    return true;
  }
  type Committed = Readonly<{ current: unknown; rows: ReadonlyMap<HTMLElement, Fiber> }>;
  function committedRows(root: Root): Committed | undefined {
    if (!capability) return;
    const current = root.current;
    const targets = new Set(doc.querySelectorAll<HTMLElement>(NATIVE));
    const ancestors = new Set<HTMLElement>();
    for (const native of targets) for (let element: HTMLElement | null = native; element; element = element.parentElement) ancestors.add(element);
    const matches = new Map<Fiber, HTMLElement[]>();
    const seen = new Set<unknown>();
    const stack: { node: unknown; owner: Fiber | null; blocked: boolean }[] = [{ node: current, owner: null, blocked: false }];
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.node === null) continue;
      if (!isFiber(entry.node) || seen.has(entry.node)) return;
      const node = entry.node;
      seen.add(node);
      if (node.sibling !== null) stack.push({ ...entry, node: node.sibling });
      const blocked = entry.blocked || node.tag === 4 || ((node.tag === 22 || node.tag === 23) && node.memoizedState !== null) ||
        (node.elementType === capability.user && entry.owner !== null);
      const owner = node.elementType === capability.user ? (blocked ? null : node) : entry.owner;
      if (isElement(node.stateNode)) {
        if (targets.has(node.stateNode)) {
          if (owner && !blocked) { const nodes = matches.get(owner) ?? []; nodes.push(node.stateNode); matches.set(owner, nodes); }
          continue;
        }
        if (!ancestors.has(node.stateNode)) continue;
      }
      if (node.child !== null) stack.push({ node: node.child, owner, blocked });
    }
    if (root.current !== current) return;
    const rows = new Map<HTMLElement, Fiber>();
    const ambiguous = new Set<HTMLElement>();
    for (const [owner, nodes] of matches) if (nodes.length === 1) {
      const native = nodes[0];
      if (rows.has(native)) ambiguous.add(native);
      rows.set(native, owner);
    }
    for (const native of ambiguous) rows.delete(native);
    return { current, rows };
  }
  function readRow(native: HTMLElement, commits?: Map<Root, Committed | undefined>): SentRow | undefined {
    if (!capability) return;
    const slot = native.parentElement;
    const row = slot?.matches("[data-message-id]") ? slot : slot?.parentElement;
    if (relinquished.has(native) || !slot || !row?.matches("[data-message-id]") || row.querySelectorAll(NATIVE).length !== 1 || !visible(native, slot)) return;
    const style = view.getComputedStyle(slot), nativeStyle = view.getComputedStyle(native);
    if (style.display !== "flex" || style.flexDirection !== "column" ||
        !["", "0"].includes(nativeStyle.order) || !["", "static", "relative"].includes(nativeStyle.position)) return;
    const root = rootFor(native);
    if (!root) return;
    let committed = commits?.get(root);
    if (!commits?.has(root)) { committed = committedRows(root); commits?.set(root, committed); }
    if (!committed || root.current !== committed.current) return;
    const current = committed.current, owner = committed.rows.get(native);
    if (!owner) return;
    const parsed = propsSchema.safeParse(owner.memoizedProps);
    if (!parsed.success || parsed.data.serverId !== options.owner.hostId || native.getAttribute("aria-busy") !== String(parsed.data.isPending)) return;
    const props = parsed.data;
    const localId = row.getAttribute("data-message-id");
    if (!localId?.trim() || (row.hasAttribute("data-history-row-id") && row.getAttribute("data-history-row-id") !== localId)) return;
    let identity: SentRowIdentity;
    if (props.messageId !== undefined) identity = { kind: "canonical", messageId: props.messageId };
    else if (props.isPending) identity = { kind: "provisional", localId };
    else return;
    const quotes = props.attachments.flatMap((attachment, index) => {
      const value = quoteSchema.safeParse(attachment);
      return value.success ? [{ index, ...value.data.externalResource, text: value.data.text }] : [];
    });
    if (!quotes.length || new Set(quotes.map((quote) => quote.id)).size !== quotes.length) return;
    type Label = { title: string; subtitle: string; titleHosts: HTMLElement[] };
    type Frame = { hosts: HTMLElement[]; labels: Label[] };
    const frames: Frame[] = [];
    const frameStack: { node: unknown; frame: Frame | null; label: Label | null; hostSeen: boolean }[] = [{ node: owner.child, frame: null, label: null, hostSeen: false }];
    const descendants = new Set<unknown>();
    while (frameStack.length) {
      const entry = frameStack.pop()!;
      if (entry.node === null) continue;
      if (!isFiber(entry.node) || descendants.has(entry.node)) return;
      const node = entry.node;
      descendants.add(node);
      if (node.sibling !== null) frameStack.push({ ...entry, node: node.sibling });
      if (node.tag === 4 || ((node.tag === 22 || node.tag === 23) && node.memoizedState !== null)) return;
      let frame = entry.frame, label = entry.label, hostSeen = entry.hostSeen;
      if (node.elementType === capability.frame) {
        if (frame) return;
        const value = z.object({ onPress: z.unknown().optional() }).safeParse(node.memoizedProps);
        if (!value.success) return;
        if (value.data.onPress !== undefined) continue;
        frame = { hosts: [], labels: [] }; label = null; hostSeen = false; frames.push(frame);
      }
      if (frame && node.elementType === capability.label) {
        const props = z.object({ title: z.string(), subtitle: z.string() }).safeParse(node.memoizedProps);
        if (!props.success) return;
        label = { ...props.data, titleHosts: [] }; frame.labels.push(label);
      }
      if (frame && isElement(node.stateNode) && !hostSeen) { frame.hosts.push(node.stateNode); hostSeen = true; }
      if (label && isElement(node.stateNode)) {
        const text = z.object({ children: z.string() }).safeParse(node.memoizedProps);
        if (text.success && text.data.children === label.title && node.stateNode.textContent === label.title) label.titleHosts.push(node.stateNode);
      }
      if (node.child !== null) frameStack.push({ node: node.child, frame, label, hostSeen });
    }
    if (frames.length !== props.attachments.length || frames.some((frame) => frame.hosts.length !== 1 || frame.labels.length !== 1)) return;
    const nodes = frames.flatMap((frame) => frame.hosts);
    const tray = nodes[0]?.parentElement;
    if (!tray || !native.contains(tray) || tray.children.length !== nodes.length ||
        nodes.some((frame, index) => relinquished.has(frame) || frame.parentElement !== tray || tray.children[index] !== frame || frame.querySelector("button,[role=button],input,textarea"))) return;
    if (quotes.some((quote) => {
      const frame = frames[quote.index], label = frame.labels[0];
      return label.titleHosts.length !== 1 || !frame.hosts[0].contains(label.titleHosts[0]) || label.title !== quote.title || label.subtitle !== `${quote.providerLabel} ${quote.identifier}` ||
        !frame.hosts[0].textContent?.includes(quote.title) || !frame.hosts[0].textContent?.includes(label.subtitle);
    })) return;
    const rootOnly = !props.message.trim() && props.images.length === 0 && quotes.length === props.attachments.length &&
      !native.querySelector('button,[role="button"],input,textarea,select,a[href],img,video,audio,canvas,[data-message-text],[data-testid="user-message-trailing-row"]');
    if (root.current !== current) return;
    return { serverId: props.serverId, agentId: props.agentId, row, localId, identity, pending: props.isPending, native, slot, root, current, labelText: frames[quotes[0].index].labels[0].titleHosts[0],
      quotes: quotes.map(({ id, title, text }) => ({ id, title, text })), frames: quotes.map((quote) => nodes[quote.index]), rootOnly,
      content: JSON.stringify([props.serverId, props.agentId, props.message, props.images, props.attachments, rootOnly]) };
  }
  function sameRow(a: SentRow, b: SentRow): boolean {
    const compatible = a.identity.kind === "provisional"
      ? b.identity.kind === "canonical" || a.identity.localId === b.identity.localId
      : b.identity.kind === "canonical" && a.identity.messageId === b.identity.messageId;
    return compatible && a.serverId === b.serverId && a.agentId === b.agentId && a.row === b.row && a.localId === b.localId &&
      a.native === b.native && a.slot === b.slot && a.labelText === b.labelText && a.content === b.content && a.root === b.root &&
      a.frames.length === b.frames.length && a.frames.every((frame, index) => frame === b.frames[index]);
  }
  function ownsOverride(entry: Override): boolean {
    return entry.element.getAttribute(HIDDEN) === entry.token && entry.element.style.getPropertyValue("display") === "none" && entry.element.style.getPropertyPriority("display") === "important";
  }
  function remove(decoration: Decoration) {
    decoration.element.remove(); decoration.popup.remove();
    for (const entry of decoration.overrides) {
      if (ownsOverride(entry)) {
        if (entry.value) entry.element.style.setProperty("display", entry.value, entry.priority);
        else entry.element.style.removeProperty("display");
      }
      if (entry.element.getAttribute(HIDDEN) === entry.token) entry.element.removeAttribute(HIDDEN);
    }
  }
  function place(decoration: Decoration) {
    if (!decoration.expanded) return;
    const pane = decoration.row.slot.closest<HTMLElement>('[data-testid^="workspace-pane-"]');
    const paneRect = pane?.getBoundingClientRect();
    const left = Math.max(8, paneRect?.left ?? 0), right = Math.min(view.innerWidth - 8, paneRect?.right ?? view.innerWidth);
    const top = Math.max(8, paneRect?.top ?? 0), bottom = Math.min(view.innerHeight - 8, paneRect?.bottom ?? view.innerHeight);
    const rect = decoration.button.getBoundingClientRect(), panel = decoration.panel;
    const width = Math.max(0, Math.min(360, right - left));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(480, bottom - top))}px`;
    const height = panel.getBoundingClientRect().height;
    panel.style.left = `${Math.max(left, Math.min(rect.right - width, right - width))}px`;
    panel.style.top = `${Math.max(top, Math.min(rect.bottom + 6, bottom - height))}px`;
  }
  function create(row: SentRow): Decoration {
    const element = doc.createElement("div");
    element.setAttribute(OWNED, "capsule");
    element.setAttribute("aria-busy", String(row.pending));
    element.setAttribute("contenteditable", "true"); element.setAttribute("aria-readonly", "true");
    Object.assign(element.style, { display: "flex", justifyContent: "flex-end", alignSelf: "flex-end", maxWidth: "100%", marginBottom: "6px", order: "0" });
    const shadow = element.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style><button class="chip" type="button" aria-expanded="false">${ANNOTATION_ICON}<span></span></button>`;
    const button = shadow.querySelector<HTMLButtonElement>(".chip")!;
    const popup = doc.createElement("div"); popup.setAttribute(OWNED, "popup");
    popup.setAttribute("contenteditable", "true"); popup.setAttribute("aria-readonly", "true");
    Object.assign(popup.style, { position: "fixed", top: "0", left: "0", width: "0", height: "0", zIndex: "2147482999" });
    const popupShadow = popup.attachShadow({ mode: "open" });
    popupShadow.innerHTML = `<style>${CSS}</style><div class="panel" contenteditable="false" role="region" aria-label="已发送的注释" hidden><header>注释</header></div>`;
    const panel = popupShadow.querySelector<HTMLDivElement>(".panel")!; panel.tabIndex = -1;
    panel.setAttribute("aria-label", row.pending ? "注释" : "已发送的注释");
    button.querySelector("span")!.textContent = `${row.quotes.length} 条注释`;
    for (const [index, quote] of row.quotes.entries()) {
      const entry = doc.createElement("section"); entry.className = "entry";
      const head = doc.createElement("div"); head.className = "entry-head";
      const title = doc.createElement("span"); title.textContent = `${index + 1}. ${quote.title}`;
      const copy = doc.createElement("button"); copy.className = "copy"; copy.type = "button"; copy.textContent = "复制全文";
      copy.addEventListener("click", () => {
        if (!valid(decoration)) return;
        if (!view.navigator.clipboard) { copy.textContent = "请选择全文复制"; return; }
        void view.navigator.clipboard.writeText(quote.text).then(() => { if (!disposed && element.isConnected) copy.textContent = "已复制"; }).catch(() => { if (element.isConnected) copy.textContent = "复制失败"; });
      });
      const text = doc.createElement("pre"); text.textContent = quote.text;
      head.append(title, copy); entry.append(head, text); panel.append(entry);
    }
    const decoration: Decoration = { row, element, popup, button, panel, expanded: false, overrides: [], close() {
      decoration.expanded = false; panel.hidden = true; button.setAttribute("aria-expanded", "false");
    } };
    const toggle = (keyboard = false) => {
      if (!valid(decoration)) { schedule(); return; }
      decoration.expanded = !decoration.expanded;
      panel.hidden = !decoration.expanded; button.setAttribute("aria-expanded", String(decoration.expanded)); place(decoration);
      if (keyboard && decoration.expanded) panel.focus({ preventScroll: true });
    };
    button.addEventListener("click", () => toggle());
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && decoration.expanded) { event.preventDefault(); event.stopPropagation(); decoration.close(); button.focus(); }
      else if (event.composedPath()[0] === button && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); toggle(true); }
    };
    for (const host of [element, popup]) {
      host.addEventListener("beforeinput", (event) => { event.preventDefault(); event.stopPropagation(); }, true);
      host.addEventListener("keydown", onKey, true);
    }
    return decoration;
  }
  function valid(decoration: Decoration): boolean {
    const latest = readRow(decoration.row.native);
    return !!latest && latest.root.current === latest.current && sameRow(decoration.row, latest);
  }
  function reconcile() {
    scheduled = false;
    if (disposed || !capability) return;
    const active = new Set<HTMLElement>();
    const commits = new Map<Root, Committed | undefined>();
    for (const native of doc.querySelectorAll<HTMLElement>(NATIVE)) {
      const previous = decorations.get(native);
      for (const entry of previous?.overrides ?? []) if (!ownsOverride(entry)) relinquished.add(entry.element);
      const row = readRow(native, commits);
      let decoration = decorations.get(native);
      if (!row) continue;
      if (decoration && (!sameRow(decoration.row, row) || decoration.element.parentElement !== row.slot || decoration.element.nextSibling !== native ||
          decoration.overrides.some((entry) => !ownsOverride(entry)))) {
        remove(decoration); decorations.delete(native); decoration = undefined;
      }
      if (!decoration) {
        const latest = readRow(native, commits);
        if (!latest || !sameRow(row, latest) || latest.root.current !== latest.current) continue;
        decoration = create(latest);
        annotationPalette(decoration.element, row.labelText, row.slot); annotationPalette(decoration.popup, row.labelText, row.slot);
        const confirmed = readRow(native, commits);
        if (!confirmed || !sameRow(latest, confirmed) || confirmed.root.current !== confirmed.current) continue;
        decoration.overrides = [...(row.rootOnly ? [native] : []), ...row.frames].map((element) => ({ element, value: element.style.getPropertyValue("display"), priority: element.style.getPropertyPriority("display"), token: crypto.randomUUID() }));
        decorations.set(native, decoration);
        row.slot.insertBefore(decoration.element, native); doc.body.append(decoration.popup);
        for (const override of decoration.overrides) {
          override.element.setAttribute(HIDDEN, override.token); override.element.style.setProperty("display", "none", "important");
        }
      } else {
        decoration.row = row;
        decoration.element.setAttribute("aria-busy", String(row.pending));
        decoration.panel.setAttribute("aria-label", row.pending ? "注释" : "已发送的注释");
        annotationPalette(decoration.element, row.labelText, row.slot); annotationPalette(decoration.popup, row.labelText, row.slot);
      }
      place(decoration); active.add(native);
    }
    for (const [native, decoration] of decorations) if (!active.has(native)) { remove(decoration); decorations.delete(native); }
  }
  function schedule() {
    if (disposed || scheduled) return;
    scheduled = true; queueMicrotask(reconcile);
  }
  const owned = (node: Node) => isElement(node) && (node.hasAttribute(OWNED) || !!node.closest(`[${OWNED}]`));
  const observer = new view.MutationObserver((changes) => {
    if (changes.some((change) => !owned(change.target) && !(change.type === "childList" && [...change.addedNodes, ...change.removedNodes].every(owned)))) schedule();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-busy", "data-message-id", "data-history-row-id", "data-testid", HIDDEN] });
  const onOutside = (event: Event) => { for (const decoration of decorations.values()) if (!event.composedPath().includes(decoration.element) && !event.composedPath().includes(decoration.popup)) decoration.close(); };
  const onViewport = () => { for (const decoration of decorations.values()) place(decoration); };
  const onVisible = () => { if (doc.visibilityState === "visible") schedule(); };
  doc.addEventListener("pointerdown", onOutside, true);
  doc.addEventListener("visibilitychange", onVisible);
  view.addEventListener("resize", onViewport);
  view.addEventListener("scroll", onViewport, true);
  const timer = view.setInterval(onVisible, 1_000);
  void (options.discover ?? discoverSentNative)(lifetime.signal).then((native) => { if (!disposed) { capability = native; schedule(); } }).catch(() => { if (!disposed) console.warn("引用插件无法确认原生消息组件，已保留原生附件。"); });
  return () => {
    if (disposed) return;
    disposed = true; lifetime.abort(); observer.disconnect(); view.clearInterval(timer);
    doc.removeEventListener("pointerdown", onOutside, true); doc.removeEventListener("visibilitychange", onVisible);
    view.removeEventListener("resize", onViewport); view.removeEventListener("scroll", onViewport, true);
    for (const decoration of decorations.values()) remove(decoration);
    decorations.clear();
  };
}
