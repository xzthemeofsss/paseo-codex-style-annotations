import { ANNOTATION_ICON as ICON, annotationPalette as palette } from "./annotation-visuals";
import {
  bindComposer, bindingStatus, currentHostId, discoverDraftHost, makeQuote, mutateQuotes, readQuotes, reason, writeQuoteComment,
  bindingElement, bindingCard, isStoreBinding, type DraftBinding, type StoreBinding, type ComposerBinding, type DraftHost, type InstallationOwner, type QuoteAttachment, type QuoteRef, type WriteOutcome,
} from "./host-draft-bridge";
import { captureSource, QuoteSources, type SourceGeometry } from "./quote-sources";
import { decodeAnnotation } from "./format";
import { decodeExternal, encodeExternal } from "./external-origin";
import type { AnnotationPreferences } from "./annotation-preferences";
import type { AnnotationKind } from "../shared/preferences";
import { discoverSourceHost, type SourceHost, type ExternalOffer, type ExternalSelection } from "./host-source-bridge";
export type { QuoteRef } from "./host-draft-bridge";

const SOURCE_BADGE_SIZE = 28;
const CSS = `
:host{font-family:var(--quote-font,system-ui,sans-serif);font-size:12px;color:var(--quote-fg);line-height:1.45}
*{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}
.chip{height:29px;display:inline-flex;align-items:center;gap:5px;padding:0 10px;border:1px solid var(--quote-border);border-radius:999px;background:var(--quote-chip);color:var(--quote-muted);white-space:nowrap}
.chip:hover{background:var(--quote-hover)}.chip:focus-visible,button:focus-visible{outline:2px solid var(--quote-muted);outline-offset:2px}
.preview{border:1px solid var(--quote-border);border-radius:12px;background:var(--quote-bg);box-shadow:none;overflow:hidden;max-height:min(480px,65vh);display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--quote-border);font-weight:600}
.close,.remove,.edit,.footer button{border:0;border-radius:5px;background:transparent;padding:3px 6px;color:var(--quote-muted)}.close:hover,.remove:hover,.edit:hover,.footer button:hover{background:var(--quote-hover)}
.entries{overflow:auto;overscroll-behavior:contain}.entry{padding:11px 12px}.entry+.entry{border-top:1px solid var(--quote-border)}
.entry-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--quote-muted)}
.entry-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry-head>.edit,.entry-head>.remove{flex-shrink:0;white-space:nowrap}
.source{display:block;width:100%;text-align:left;border:0;background:none;padding:0}.comment{margin-top:6px;color:var(--quote-muted);white-space:pre-wrap;overflow-wrap:anywhere}.editor{padding:10px}.footer{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}.status,.location{font-size:11px;color:var(--quote-muted)}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0 0;user-select:text;-webkit-user-select:text}
.notice{padding:0 12px 10px;color:var(--quote-muted)}.notice:empty{display:none}
.save-state{font-size:11px;color:var(--quote-muted);margin-top:4px}.retry{border:0;background:transparent;text-decoration:underline;padding:2px 0}
.editor{position:relative;padding:4px 12px;border-radius:18px}
.comment-row{position:relative}.editor .location:empty{display:none}.editor .location:not(:empty){padding:4px 0}
.editor .footer{position:absolute;top:4px;right:0;margin:0;height:28px;align-items:center}
.editor .footer button{display:inline-flex;align-items:center;justify-content:center;height:28px;border:0;border-radius:50%;background:transparent;padding:0;color:var(--quote-muted)}
.editor .footer button[hidden]{display:none}.editor .footer button[data-action="finish"]{width:28px}.editor .footer button:hover{background:var(--quote-hover)}
.feedback{display:none;align-items:flex-start;gap:8px;padding:4px 0}.feedback .status{flex:1;overflow-wrap:anywhere}.feedback .retry{flex-shrink:0}
.editor:has([data-action="retry"]:not([hidden])) .feedback{display:flex}
.editor.edit-card{padding:8px 12px;border-radius:22px;gap:8px}
.edit-card .footer{position:static;display:flex;gap:6px;height:28px;margin:0}
.edit-card .footer button{border-radius:999px;padding:0 10px}
.edit-card .footer [data-action="delete"]{margin-right:auto;width:28px;padding:0}
.edit-card .footer [data-action="cancel"]{border:1px solid var(--quote-border)}
.edit-card .footer [data-action="save"]{background:var(--quote-fg);color:var(--quote-bg)}
.edit-card .feedback:not([hidden]){display:flex}.edit-card .feedback[hidden]{display:none}
`;
interface Projection {
  binding: ComposerBinding;
  element: HTMLDivElement;
  button: HTMLButtonElement;
}
export interface QuoteComposer {
  add(input: { composer: unknown; anchor: unknown; agentId: string; formattedText: string; preview: string; focusComposer?: boolean; sourceRange?: unknown; openComment?: boolean }): Promise<AddResult>;
  addExternal(offer: ExternalOffer, recipient: StoreBinding): Promise<AddResult>;
  observeExternal(listener: (selection: ExternalSelection) => void): () => void;
  setComment(ref: QuoteRef, comment: string): Promise<WriteOutcome>;
  dispose(): void;
}
export type AddResult =
  | { kind: "committed"; ref: QuoteRef }
  | { kind: "uncertain"; ref: QuoteRef; reason: string }
  | Extract<WriteOutcome, { kind: "not-written" }>;

export function installQuoteComposer(options: { owner: InstallationOwner; discover?: (signal: AbortSignal) => Promise<DraftHost>; discoverSources?: (input: { owner: InstallationOwner; signal: AbortSignal }) => Promise<SourceHost>; preferences?: AnnotationPreferences }): QuoteComposer {
  const lifetime = new AbortController();
  const sources = new QuoteSources();
  const marker = `quote-${crypto.randomUUID()}`;
  const hidden = new Set<HTMLElement>();
  const projections = new Map<HTMLTextAreaElement, Projection>();
  const styles = document.createElement("style");
  styles.textContent = `[data-paseo-quote-hidden="${marker}"]{display:none!important}`;
  document.head.append(styles);
  let host: DraftHost | null = null;
  let unsubscribe = () => {};
  let scheduled = false;
  let frame = 0;
  let closeTimer = 0;
  let revision = 0;
  type Pending = { comment: string; revision: number } & ({ kind: "saving" } | { kind: "error"; reason: string });
  const pending = new Map<string, Map<QuoteRef["id"], Pending>>();
  type Row = { element: HTMLDivElement; source: HTMLButtonElement; text: HTMLPreElement; comment: HTMLDivElement; label: HTMLSpanElement; edit: HTMLButtonElement; remove: HTMLButtonElement; status: HTMLDivElement };
  type Summary = { element: HTMLDivElement; projection: Projection; mode: "hover" | "pinned"; rows: Map<QuoteRef["id"], Row>; container: HTMLElement; heading: HTMLElement; notice: HTMLElement };
  let preview: Summary | null = null;
  type EditorView = { element: HTMLDivElement; field: HTMLTextAreaElement; status: HTMLElement; location: HTMLElement; retry: HTMLButtonElement; origin: HTMLElement; ref: QuoteRef; scope: string; composing: boolean; version: number };
  type CreatePhase = { kind: "adding" | "ready" } | { kind: "add-error"; retry: () => void };
  type EditCommand = { kind: "save"; comment: string } | { kind: "delete" };
  type EditPhase = { kind: "idle" } | { kind: "writing"; command: EditCommand } | { kind: "error"; command: EditCommand; outcome: Exclude<WriteOutcome, { kind: "committed" }> };
  type Editor = { kind: "closed" } | { kind: "create"; view: EditorView; phase: CreatePhase; finishRequested: { focus: boolean } | null } | { kind: "edit"; view: EditorView; phase: EditPhase };
  type EditSession = Extract<Editor, { kind: "edit" }>;
  let editor: Editor = { kind: "closed" };
  const decorations = new Map<Projection, Map<QuoteRef["id"], { element: HTMLDivElement; button: HTMLButtonElement; highlights: HTMLDivElement[] }>>();
  const scopeOf = (binding: DraftBinding) => host?.key(binding.hostId, binding.agentId) ?? `${binding.hostId}\0${binding.agentId}`;
  const quotesFor = (binding: DraftBinding) => host ? readQuotes(host.read(scopeOf(binding))) : [];
  const sourceFor = (binding: DraftBinding, id: QuoteRef["id"]) => {
    const source = sources.resolve(scopeOf(binding), id);
    return source?.transcript === binding.anchor ? source : sources.externalFor(scopeOf(binding), id);
  };
  let sourceHost: SourceHost | null = null;
  let sourcePromise: Promise<SourceHost> | null = null;
  const sourceObservers = new Set<() => void>();
  const getSourceHost = () => sourcePromise ??= (options.discoverSources ?? discoverSourceHost)({ owner: options.owner, signal: lifetime.signal }).then((value) => {
    if (lifetime.signal.aborted) { value.dispose(); throw new Error("注释插件已关闭。"); }
    sourceHost = value; return value;
  });
  const hasLocation = (binding: DraftBinding, id: QuoteRef["id"]) => !!sourceFor(binding, id) || quotesFor(binding).some((quote) => quote.item.id === id && decodeExternal(quote.item).kind === "external");
  const reveal = async (binding: DraftBinding, id: QuoteRef["id"]) => {
    const live = sources.externalFor(scopeOf(binding), id);
    if (live) { const result = await live.reveal(); if (result.kind === "highlighted") return result; }
    if (sources.resolve(scopeOf(binding), id) && sources.reveal(scopeOf(binding), id)) return { kind: "highlighted" } as const;
    const item = quotesFor(binding).find((quote) => quote.item.id === id)?.item;
    const saved = item && decodeExternal(item);
    if (!saved || saved.kind !== "external") return { kind: "unavailable", reason: "原文位置不可用" } as const;
    try { return await (await getSourceHost()).reveal(saved.snapshot); } catch (cause) { return { kind: "unavailable", reason: reason(cause) } as const; }
  };
  const pendingFor = (scope: string) => {
    let values = pending.get(scope);
    if (!values) { values = new Map(); pending.set(scope, values); }
    return values;
  };
  const setComment: QuoteComposer["setComment"] = async (ref, comment) => {
    const values = pendingFor(scopeOf(ref.binding));
    const edit = { comment, revision: ++revision };
    values.set(ref.id, { ...edit, kind: "saving" });
    const outcome = host ? writeQuoteComment({ host, ref, comment, isCurrent: () => !lifetime.signal.aborted })
      : { kind: "not-written", reason: "草稿接口尚未就绪，评论尚未保存。", fallback: false } satisfies WriteOutcome;
    schedule();
    if (outcome.kind !== "committed") { values.set(ref.id, { ...edit, kind: "error", reason: outcome.reason }); return outcome; }
    try {
      await host?.flush();
      if (values.get(ref.id)?.revision === edit.revision) values.delete(ref.id);
      schedule();
      return { kind: "committed" };
    } catch (cause) {
      const message = `评论已写入草稿，持久保存未确认，可重试。${reason(cause)}`;
      if (values.get(ref.id)?.revision === edit.revision) values.set(ref.id, { ...edit, kind: "error", reason: message });
      schedule();
      return { kind: "uncertain", reason: message };
    }
  };
  function closeEditor(focus: boolean) {
    if (editor.kind === "closed") return;
    const { view } = editor;
    editor = { kind: "closed" };
    view.element.remove();
    if (focus && bindingStatus(view.ref.binding) === "ready") (view.origin.isConnected ? view.origin : bindingElement(view.ref.binding)).focus({ preventScroll: true });
  }
  function saveCreateComment(view: EditorView) {
    if (editor.kind !== "create" || editor.view !== view || editor.phase.kind !== "ready" || view.composing) return;
    const version = ++view.version;
    view.status.textContent = "正在保存评论…";
    view.retry.hidden = true;
    void setComment(view.ref, view.field.value).then((outcome) => {
      if (editor.kind !== "create" || editor.view !== view || version !== view.version) return;
      if (bindingStatus(view.ref.binding) === "scope-changed") { closeEditor(false); return; }
      view.status.textContent = outcome.kind === "committed" ? "已保存" : outcome.reason;
      view.retry.hidden = outcome.kind === "committed";
      if (outcome.kind === "committed" && editor.finishRequested && !view.composing) closeEditor(editor.finishRequested.focus);
    });
  }
  function dismissEditor(view: EditorView, focus: boolean) {
    if (editor.kind === "closed" || editor.view !== view || view.composing) return;
    if (editor.kind === "edit") {
      if (editor.phase.kind !== "writing") closeEditor(focus);
      return;
    }
    editor.finishRequested = { focus };
    saveCreateComment(view);
  }
  function renderEdit(session: EditSession) {
    const { view, phase } = session;
    const writing = phase.kind === "writing";
    const uncertain = phase.kind === "error" && phase.outcome.kind === "uncertain";
    view.field.disabled = writing || uncertain;
    for (const button of view.element.shadowRoot?.querySelectorAll<HTMLButtonElement>(".footer button") ?? []) {
      button.disabled = writing || (uncertain && button.dataset.action !== "cancel");
    }
    view.retry.hidden = phase.kind !== "error";
    view.retry.textContent = phase.kind === "error" && phase.command.kind === "delete" ? "重试删除" : "重试保存";
    view.status.textContent = phase.kind === "idle" ? "" : writing
      ? (phase.command.kind === "save" ? "正在保存评论…" : "正在删除注释…")
      : uncertain ? (phase.command.kind === "delete" ? "删除结果未确认，注释可能已移除。重试会确认同一操作。"
        : `保存结果未确认，操作可能已生效。重试会提交同一操作。${phase.outcome.reason}`) : phase.outcome.reason;
    const feedback = view.status.parentElement;
    if (feedback) feedback.hidden = phase.kind === "idle";
  }
  async function submitEdit(session: EditSession, command: EditCommand) {
    const { view } = session;
    if (editor !== session || session.phase.kind === "writing" || view.composing) return;
    if (bindingStatus(view.ref.binding) === "scope-changed") { closeEditor(false); return; }
    const version = ++view.version;
    session.phase = { kind: "writing", command };
    renderEdit(session);
    let outcome: WriteOutcome;
    if (command.kind === "save") outcome = await setComment(view.ref, command.comment);
    else if (!host) outcome = { kind: "not-written", reason: "草稿接口尚未就绪，注释未删除。", fallback: false };
    else {
      outcome = await mutateQuotes({ host, binding: view.ref.binding, change: { kind: "remove", id: view.ref.id }, isCurrent: () => !lifetime.signal.aborted });
    }
    if (editor !== session || view.version !== version) return;
    if (bindingStatus(view.ref.binding) === "scope-changed") { closeEditor(false); return; }
    if (outcome.kind === "committed") { closeEditor(true); schedule(); return; }
    session.phase = { kind: "error", command, outcome };
    renderEdit(session); requestLayout();
  }
  function createEditor(ref: QuoteRef, origin: HTMLElement, input: { kind: "create" | "edit"; comment: string }): EditorView {
    closeEditor(false);
    closePreview(false);
    const element = document.createElement("div");
    element.setAttribute("data-paseo-quote-editor", "");
    element.setAttribute("contenteditable", "true");
    element.setAttribute("aria-readonly", "true");
    element.style.cssText = "position:fixed;z-index:2147483646;width:294px;max-width:calc(100vw - 16px)";
    palette(element, bindingElement(ref.binding));
    const shadow = element.attachShadow({ mode: "open" });
    const footer = input.kind === "create"
      ? `<button type="button" data-action="finish" aria-label="完成评论"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>`
      : `<button type="button" data-action="delete" aria-label="删除注释"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg></button><button type="button" data-action="cancel">取消</button><button type="button" data-action="save">保存</button>`;
    shadow.innerHTML = `<style>${CSS}</style><section class="preview editor${input.kind === "edit" ? " edit-card" : ""}" contenteditable="false" role="dialog" aria-label="引用评论"><div class="location"></div><div class="comment-row"><slot name="comment"></slot>${input.kind === "create" ? `<div class="footer">${footer}</div>` : ""}</div>${input.kind === "edit" ? `<div class="footer">${footer}</div>` : ""}<div class="feedback"${input.kind === "edit" ? " hidden" : ""}><div class="status" role="status"></div><button type="button" class="retry" data-action="retry" hidden>重试保存</button></div></section>`;
    const field = document.createElement("textarea");
    field.slot = "comment"; field.rows = 1; field.placeholder = "添加可选评论..."; field.value = input.comment;
    field.setAttribute("aria-label", "添加可选评论"); field.setAttribute("data-paseo-quote-comment", "");
    for (const [property, value] of [
      ["all", "unset"], ["display", "block"], ["box-sizing", "border-box"], ["width", "100%"], ["min-height", "36px"], ["max-height", input.kind === "edit" ? "180px" : "160px"],
      ["margin", "0"], ["padding", input.kind === "edit" ? "8px 0" : "8px 36px 8px 0"], ["border", "0"], ["outline", "none"], ["box-shadow", "none"], ["border-radius", "0"],
      ["background", "transparent"], ["color", "var(--quote-fg)"], ["font-family", "var(--quote-font)"], ["font-size", "13px"], ["line-height", "20px"],
      ["white-space", "pre-wrap"], ["overflow-wrap", "anywhere"], ["overflow-y", "auto"], ["resize", "none"],
      ["user-select", "text"], ["-webkit-user-select", "text"], ["cursor", "text"],
    ] as const) field.style.setProperty(property, value, "important");
    const status = shadow.querySelector<HTMLElement>(".status")!;
    const location = shadow.querySelector<HTMLElement>(".location")!;
    const retry = shadow.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
    const view: EditorView = { element, field, status, location, retry, origin, ref, scope: scopeOf(ref.binding), composing: false, version: 0 };
    const resize = () => {
      if (input.kind === "create") field.rows = Math.min(5, field.value.split("\n").length);
      else {
        field.style.setProperty("height", "36px", "important");
        field.style.setProperty("height", `${Math.max(36, Math.min(180, field.scrollHeight))}px`, "important");
      }
    };
    const finish = () => dismissEditor(view, true);
    field.addEventListener("input", () => {
      if (editor.kind === "create" && editor.view === view) editor.finishRequested = null;
      resize(); saveCreateComment(view); requestLayout();
    });
    field.addEventListener("compositionstart", () => {
      view.composing = true;
      if (editor.kind === "create" && editor.view === view) { editor.finishRequested = null; view.version++; }
    });
    field.addEventListener("compositionend", () => { view.composing = false; resize(); saveCreateComment(view); requestLayout(); });
    field.addEventListener("blur", () => { if (!view.composing) saveCreateComment(view); });
    element.addEventListener("beforeinput", (event) => { if (!event.composedPath().includes(field)) event.preventDefault(); event.stopPropagation(); }, true);
    element.addEventListener("keydown", (event) => {
      if (view.composing || event.isComposing || event.keyCode === 229 || editor.kind === "closed" || editor.view !== view) return;
      if (editor.kind === "edit") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(); }
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault(); event.stopPropagation();
          if (editor.phase.kind !== "error" || editor.phase.outcome.kind !== "uncertain") void submitEdit(editor, { kind: "save", comment: field.value });
        }
        return;
      }
      if (event.key !== "Escape" && (event.key !== "Enter" || event.shiftKey || event.altKey)) return;
      event.preventDefault(); event.stopPropagation(); finish();
    }, true);
    retry.addEventListener("click", () => {
      if (editor.kind === "closed" || editor.view !== view || view.composing) return;
      if (editor.kind === "create" && editor.phase.kind === "add-error") editor.phase.retry();
      else if (editor.kind === "edit" && editor.phase.kind === "error") void submitEdit(editor, editor.phase.command);
      else saveCreateComment(view);
    });
    shadow.querySelector('[data-action="finish"]')?.addEventListener("click", finish);
    shadow.querySelector('[data-action="cancel"]')?.addEventListener("click", finish);
    for (const kind of ["save", "delete"] as const) shadow.querySelector(`[data-action="${kind}"]`)?.addEventListener("click", () => {
      if (editor.kind === "edit" && editor.view === view) void submitEdit(editor, kind === "save" ? { kind, comment: field.value } : { kind });
    });
    element.append(field); document.body.append(element); resize();
    return view;
  }
  function openEditor(projection: Projection, id: QuoteRef["id"], origin: HTMLElement) {
    if (editor.kind === "edit" && editor.phase.kind === "writing") return;
    const attachment = quotesFor(projection.binding).find((entry) => entry.item.id === id);
    if (!attachment || bindingStatus(projection.binding) !== "ready") return;
    const decoded = decodeAnnotation(attachment.item);
    if (decoded.kind !== "editable") return;
    const scope = scopeOf(projection.binding);
    const view = createEditor({ binding: projection.binding, id }, origin, { kind: "edit", comment: pending.get(scope)?.get(id)?.comment ?? decoded.annotation.comment });
    editor = { kind: "edit", view, phase: { kind: "idle" } };
    view.field.focus({ preventScroll: true }); requestLayout();
  }
  function closePreview(focus: boolean) {
    window.clearTimeout(closeTimer);
    if (!preview) return;
    const current = preview; preview = null;
    current.element.remove(); current.projection.button.setAttribute("aria-expanded", "false");
    if (focus && current.projection.binding.input.isConnected) current.projection.binding.input.focus({ preventScroll: true });
  }
  function delayClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (preview?.mode !== "hover") return;
      if (preview.element.matches(":hover") || preview.projection.element.matches(":hover") || preview.element.matches(":focus-within") || preview.projection.element.matches(":focus-within")) return;
      closePreview(false);
    }, 100);
  }
  function updatePreview() {
    if (!preview) return;
    const current = preview, { binding } = current.projection, scope = scopeOf(binding);
    const entries = quotesFor(binding), ids = new Set(entries.map((entry) => entry.item.id));
    if (!entries.length) { closePreview(false); binding.input.focus({ preventScroll: true }); return; }
    current.heading.textContent = `${entries.length} 条注释`;
    for (const [id, row] of current.rows) if (!ids.has(id)) { row.element.remove(); current.rows.delete(id); }
    entries.forEach((attachment, index) => {
      const id = attachment.item.id;
      let row = current.rows.get(id);
      if (!row) {
        const element = document.createElement("div"); element.className = "entry";
        const head = document.createElement("div"); head.className = "entry-head";
        const label = document.createElement("span"); label.className = "entry-label";
        const edit = document.createElement("button"); edit.className = "edit"; edit.textContent = "编辑";
        const remove = document.createElement("button"); remove.className = "remove"; remove.textContent = "移除";
        const source = document.createElement("button"); source.className = "source";
        const text = document.createElement("pre"); source.append(text);
        const comment = document.createElement("div"); comment.className = "comment";
        const status = document.createElement("div"); status.className = "save-state";
        head.append(label, edit, remove); element.append(head, source, comment, status);
        row = { element, source, text, comment, label, edit, remove, status };
        current.rows.set(id, row); current.container.append(element);
        edit.addEventListener("click", () => openEditor(current.projection, id, current.projection.button));
        source.addEventListener("click", () => {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && source.contains(selection.anchorNode)) return;
          void reveal(current.projection.binding, id).then((result) => {
            if (preview !== current) return;
            if (result.kind === "highlighted") { closePreview(false); requestLayout(); }
            else current.notice.textContent = result.reason;
          });
        });
        remove.addEventListener("click", () => {
          if (!host || remove.disabled) return;
          const order = Array.from(current.rows.values()), at = order.findIndex((item) => item.remove === remove);
          const next = order[at + 1]?.remove ?? order[at - 1]?.remove;
          const focused = current.element.shadowRoot?.activeElement === remove;
          remove.disabled = true;
          void mutateQuotes({ host, binding: current.projection.binding, change: { kind: "remove", id }, isCurrent: () => !lifetime.signal.aborted }).then((outcome) => {
            if (lifetime.signal.aborted) return;
            if (!quotesFor(binding).some((entry) => entry.item.id === id)) pending.get(scope)?.delete(id);
            if (preview !== current) return;
            current.notice.textContent = outcome.kind === "committed" ? "" : outcome.reason;
            updatePreview();
            if (focused && next?.isConnected) next.focus({ preventScroll: true });
            remove.disabled = bindingStatus(current.projection.binding) !== "ready";
            schedule();
          });
        });
      }
      const decoded = decodeAnnotation(attachment.item), unsaved = pending.get(scope)?.get(id);
      const external = decodeExternal(attachment.item);
      const terminal = external.kind === "external" && external.snapshot.origin.kind === "terminal" ? external.snapshot.origin : null;
      const title = terminal ? `终端 · 缓冲区 ${terminal.start.y + 1}${terminal.end.y === terminal.start.y ? "" : `-${terminal.end.y + 1}`}` : attachment.item.title;
      const ordinal = external.kind === "external" ? `${index + 1}. ${title}` : `${index + 1}.`, quote = external.kind === "external" ? external.snapshot.text : decoded.kind === "editable" ? decoded.annotation.quote : attachment.item.text;
      const comment = unsaved?.comment ?? (decoded.kind === "editable" ? decoded.annotation.comment : "");
      if (row.label.textContent !== ordinal) row.label.textContent = ordinal;
      row.label.title = `${index + 1}. ${attachment.item.title}`;
      if (row.text.textContent !== quote) row.text.textContent = quote;
      if (row.comment.textContent !== comment) row.comment.textContent = comment;
      const position = current.container.children[index];
      if (position !== row.element) current.container.insertBefore(row.element, position ?? null);
      row.source.disabled = !hasLocation(binding, id);
      row.source.title = row.source.disabled ? "原文位置不可用" : "定位原文";
      row.status.textContent = unsaved?.kind === "error" ? unsaved.reason : row.source.disabled ? "原文位置不可用" : "";
      row.edit.disabled = decoded.kind !== "editable" || bindingStatus(binding) !== "ready";
      row.remove.disabled = bindingStatus(binding) !== "ready";
      row.edit.setAttribute("aria-label", `编辑引用 ${index + 1}`); row.remove.setAttribute("aria-label", `移除引用 ${index + 1}`);
    });
  }
  function openPreview(projection: Projection, mode: Summary["mode"]) {
    window.clearTimeout(closeTimer);
    if (preview?.projection === projection) {
      if (mode === "pinned") { preview.mode = mode; preview.element.shadowRoot?.querySelector<HTMLElement>(".close")?.focus({ preventScroll: true }); }
      return;
    }
    closePreview(false);
    if (!quotesFor(projection.binding).length) return;
    const element = document.createElement("div");
    element.setAttribute("data-paseo-quote-preview", ""); element.setAttribute("contenteditable", "true"); element.setAttribute("aria-readonly", "true");
    element.style.cssText = "position:fixed;z-index:2147483646;width:294px;max-width:calc(100vw - 16px)";
    palette(element, projection.binding.input);
    const shadow = element.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style><section class="preview" contenteditable="false" role="dialog" aria-label="引用注释"><header><span></span><button class="close" aria-label="关闭引用预览">×</button></header><div class="entries"></div><div class="notice" role="status"></div></section>`;
    preview = { element, projection, mode, rows: new Map(), container: shadow.querySelector<HTMLElement>(".entries")!, heading: shadow.querySelector<HTMLElement>("header span")!, notice: shadow.querySelector<HTMLElement>(".notice")! };
    shadow.querySelector(".close")?.addEventListener("click", () => closePreview(true));
    element.addEventListener("pointerenter", () => window.clearTimeout(closeTimer));
    element.addEventListener("pointerleave", delayClose); element.addEventListener("focusout", delayClose);
    element.addEventListener("beforeinput", (event) => { event.preventDefault(); event.stopPropagation(); }, true);
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation(); closePreview(true);
    }, true);
    document.body.append(element); projection.button.setAttribute("aria-expanded", "true");
    updatePreview(); requestLayout();
    if (mode === "pinned") shadow.querySelector<HTMLElement>(".close")?.focus({ preventScroll: true });
  }
  const concealNativePills = (projection: Projection, entries: QuoteAttachment[]) => {
    const root = projection.binding.input.closest('[data-testid="message-input-root"]');
    if (!root) return;
    const pills = Array.from(root.querySelectorAll('[data-testid="composer-plugin-resource-attachment-pill"]'));
    for (const entry of entries) {
      const matching = pills.filter((pill) => pill.textContent?.includes(entry.item.identifier));
      if (matching.length !== 1 || !(matching[0] instanceof HTMLElement)) continue;
      const pill = matching[0];
      const tray = pill.closest('[data-testid="composer-attachment-tray"]');
      if (!tray) continue;
      let frame = pill;
      while (frame.parentElement && frame.parentElement !== tray) frame = frame.parentElement;
      const count = frame.querySelectorAll('[data-testid$="-attachment-pill"]').length
        + Number(frame.matches('[data-testid$="-attachment-pill"]'));
      if (frame.parentElement === tray && count === 1) hidden.add(frame);
    }
    for (const tray of root.querySelectorAll('[data-testid="composer-attachment-tray"]')) {
      if (tray instanceof HTMLElement && tray.children.length > 0 && Array.from(tray.children).every((child) => child instanceof HTMLElement && hidden.has(child))) hidden.add(tray);
    }
  };
  function paneBounds(binding: DraftBinding) {
    const rect = binding.pane.getBoundingClientRect();
    if (!binding.pane.isConnected || rect.width <= 0 || rect.height <= 0) return { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
    return { left: Math.max(0, rect.left), right: Math.min(window.innerWidth, rect.right), top: Math.max(0, rect.top), bottom: Math.min(window.innerHeight, rect.bottom) };
  }
  function place(element: HTMLElement, anchor: DOMRect, bounds: { left: number; right: number; top: number; bottom: number }) {
    const width = Math.min(294, Math.max(0, bounds.right - bounds.left - 16));
    element.style.width = `${width}px`;
    const height = element.offsetHeight;
    const above = anchor.top - height - 8;
    const top = above >= bounds.top + 8 ? above : anchor.bottom + 8;
    element.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.left + anchor.width / 2 - width / 2, bounds.right - width - 8))}px`;
    element.style.top = `${Math.max(bounds.top + 8, Math.min(top, bounds.bottom - height - 8))}px`;
    element.style.maxHeight = `${Math.max(0, bounds.bottom - bounds.top - 16)}px`;
    element.style.overflowY = "auto";
  }
  function layout() {
    frame = 0;
    if (lifetime.signal.aborted) return;
    let active = false;
    if (preview) {
      if (bindingStatus(preview.projection.binding) === "scope-changed") closePreview(false);
      else {
        place(preview.element, preview.projection.button.getBoundingClientRect(), paneBounds(preview.projection.binding));
        for (const [id, row] of preview.rows) {
          row.source.disabled = !hasLocation(preview.projection.binding, id);
          row.source.title = row.source.disabled ? "原文位置不可用" : "定位原文";
        }
        active = true;
      }
    }
    if (editor.kind !== "closed") {
      const { view } = editor;
      if (bindingStatus(view.ref.binding) === "scope-changed") closeEditor(false);
      else {
        const geometry: SourceGeometry = sourceFor(view.ref.binding, view.ref.id) ? sources.geometry(view.scope, view.ref.id, bindingCard(view.ref.binding)) : { kind: "unavailable" };
        const projection = isStoreBinding(view.ref.binding) ? undefined : projections.get(view.ref.binding.input);
        if (geometry.kind === "visible") {
          place(view.element, geometry.rects[0], geometry.bounds); view.location.textContent = "";
        } else {
          place(view.element, (projection?.button ?? bindingElement(view.ref.binding)).getBoundingClientRect(), paneBounds(view.ref.binding));
          view.location.textContent = geometry.kind === "offscreen" ? "原文在可视区域外" : "原文位置不可用";
        }
        active = true;
      }
    }
    for (const projection of projections.values()) {
      const scope = scopeOf(projection.binding), entries = quotesFor(projection.binding);
      let markers = decorations.get(projection);
      if (!markers) { markers = new Map(); decorations.set(projection, markers); }
      const ids = new Set(entries.map((entry) => entry.item.id));
      for (const [id, decoration] of markers) if (!ids.has(id)) { decoration.element.remove(); markers.delete(id); }
      const placed: Array<{ left: number; top: number }> = [];
      entries.forEach((entry, index) => {
        const geometry = bindingStatus(projection.binding) === "ready" && sourceFor(projection.binding, entry.item.id) ? sources.geometry(scope, entry.item.id, projection.binding.card) : { kind: "unavailable" };
        let decoration = markers.get(entry.item.id);
        if (geometry.kind !== "visible" || !("rects" in geometry)) { if (decoration) decoration.element.hidden = true; return; }
        active = true;
        if (!decoration) {
          const element = document.createElement("div"); element.setAttribute("data-paseo-quote-source", "");
          element.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483001";
          element.setAttribute("contenteditable", "true"); element.setAttribute("aria-readonly", "true");
          element.addEventListener("beforeinput", (event) => { event.preventDefault(); event.stopPropagation(); }, true);
          const button = document.createElement("button"); button.type = "button";
          button.style.cssText = `position:absolute;pointer-events:auto;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:1px solid #e8eddf;background:#a7c080;color:#fff;border-radius:999px 999px 999px 0;min-width:${SOURCE_BADGE_SIZE}px;height:${SOURCE_BADGE_SIZE}px;font:500 13px/1 var(--quote-font,system-ui);padding:0 6px;box-shadow:0 1px 2px #0003;cursor:pointer`;
          button.addEventListener("click", () => openEditor(projection, entry.item.id, projection.button));
          palette(element, projection.binding.input);
          element.append(button); document.body.append(element);
          decoration = { element, button, highlights: [] }; markers.set(entry.item.id, decoration);
        }
        decoration.element.hidden = false;
        if (decoration.button.textContent !== String(index + 1)) decoration.button.textContent = String(index + 1);
        decoration.button.setAttribute("aria-label", `编辑引用 ${index + 1}`);
        const last = geometry.rects[geometry.rects.length - 1];
        const spacing = SOURCE_BADGE_SIZE + 4;
        const left = Math.min(last.right, geometry.bounds.right - spacing);
        let top = Math.max(geometry.bounds.top, last.bottom - 12);
        while (placed.some((point) => Math.abs(point.left - left) < spacing && Math.abs(point.top - top) < spacing)) top += spacing;
        placed.push({ left, top });
        decoration.button.style.left = `${left}px`;
        decoration.button.style.top = `${top}px`;
        while (decoration.highlights.length > geometry.rects.length) decoration.highlights.pop()?.remove();
        geometry.rects.forEach((rect, i) => {
          let highlight = decoration.highlights[i];
          if (!highlight) { highlight = document.createElement("div"); decoration.highlights.push(highlight); decoration.element.prepend(highlight); }
          highlight.style.cssText = `position:absolute;pointer-events:none;background:rgba(225,177,43,.18);border-bottom:1px solid rgba(190,145,25,.5);left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
        });
      });
    }
    if (active) requestLayout();
  }
  function requestLayout() { if (!frame && !lifetime.signal.aborted) frame = window.requestAnimationFrame(layout); }
  function sync() {
    scheduled = false;
    if (!host || lifetime.signal.aborted) return;
    const previousHidden = new Set(hidden); hidden.clear();
    const active = new Set<HTMLTextAreaElement>();
    for (const input of document.querySelectorAll("textarea[data-composer-input]")) {
      if (!(input instanceof HTMLTextAreaElement) || !input.getClientRects().length) continue;
      const pane = input.closest('[data-testid^="workspace-pane-"]');
      const transcripts = pane && Array.from(pane.querySelectorAll('[data-testid="agent-chat-scroll"]')).filter((node) => node.getClientRects().length);
      const tabs = pane && Array.from(pane.querySelectorAll('[data-testid^="workspace-tab-agent_"][aria-selected="true"]')).filter((node) => node.getClientRects().length);
      if (!transcripts || transcripts.length !== 1 || !tabs || tabs.length !== 1) continue;
      const agentId = tabs[0].getAttribute("data-testid")?.slice("workspace-tab-agent_".length);
      if (!agentId) continue;
      const binding = bindComposer(input, transcripts[0], agentId);
      if (!binding || binding.hostId !== options.owner.hostId) continue;
      try { if (!host.hasAgent(binding.hostId, binding.agentId)) continue; } catch { continue; }
      const entries = quotesFor(binding), scope = scopeOf(binding);
      const retained = new Set(entries.map((entry) => entry.item.id));
      if (editor.kind === "create" && editor.phase.kind === "adding" && editor.view.scope === scope) retained.add(editor.view.ref.id);
      sources.retain(scope, retained);
      for (const id of pending.get(scope)?.keys() ?? []) if (!retained.has(id)) pending.get(scope)?.delete(id);
      if (editor.kind !== "closed" && editor.view.scope === scope && !retained.has(editor.view.ref.id)
        && (editor.kind === "create" ? editor.phase.kind === "ready"
          : editor.phase.kind === "idle" || editor.phase.command.kind !== "delete")) closeEditor(false);
      if (!entries.length || !binding.card) continue;
      active.add(input);
      let projection = projections.get(input);
      if (!projection) {
        const element = document.createElement("div"); element.setAttribute("data-paseo-quote-chip", "");
        element.style.cssText = "display:flex;align-items:flex-start;flex-shrink:0;align-self:stretch;position:relative";
        const shadow = element.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>${CSS}</style><button class="chip" type="button" aria-haspopup="dialog" aria-expanded="false">${ICON}<span></span></button>`;
        const button = shadow.querySelector<HTMLButtonElement>("button")!;
        projection = { binding, element, button };
        const created = projection;
        button.addEventListener("click", () => { if (preview?.projection === created && preview.mode === "pinned") closePreview(false); else openPreview(created, "pinned"); });
        button.addEventListener("pointerenter", () => openPreview(created, "hover"));
        button.addEventListener("focus", () => openPreview(created, "hover"));
        element.addEventListener("pointerleave", delayClose); element.addEventListener("focusout", delayClose);
        projections.set(input, projection);
      }
      if (scopeOf(projection.binding) !== scope && preview?.projection === projection) closePreview(false);
      projection.binding = binding;
      if (projection.element.parentElement !== binding.card) binding.card.prepend(projection.element);
      palette(projection.element, input);
      for (const decoration of decorations.get(projection)?.values() ?? []) palette(decoration.element, input);
      const label = projection.button.querySelector("span");
      const title = `${entries.length} 条注释`;
      if (label && label.textContent !== title) label.textContent = title;
      projection.button.setAttribute("aria-label", `查看 ${title}`);
      if (projection.element.isConnected) concealNativePills(projection, entries);
    }
    for (const [input, projection] of projections) if (!active.has(input)) {
      if (preview?.projection === projection) {
        const replacement = Array.from(projections.values()).find((value) => active.has(value.binding.input) && scopeOf(value.binding) === scopeOf(projection.binding) && value.binding.pane === projection.binding.pane);
        if (replacement) preview.projection = replacement; else closePreview(false);
      }
      projection.element.remove(); projections.delete(input);
      for (const decoration of decorations.get(projection)?.values() ?? []) decoration.element.remove();
      decorations.delete(projection);
    }
    for (const element of previousHidden) if (!hidden.has(element) && element.getAttribute("data-paseo-quote-hidden") === marker) element.removeAttribute("data-paseo-quote-hidden");
    for (const element of hidden) if (element.getAttribute("data-paseo-quote-hidden") !== marker) element.setAttribute("data-paseo-quote-hidden", marker);
    updatePreview(); requestLayout();
  }
  function schedule() { if (!scheduled && !lifetime.signal.aborted) { scheduled = true; queueMicrotask(sync); } }
  const observer = new MutationObserver((records) => {
    const hostSelector = '[data-testid^="workspace-pane-"],[data-testid="message-input-root"],[data-testid^="workspace-tab-agent_"]';
    if (records.some((record) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest('[data-paseo-quote-chip],[data-paseo-quote-source],[data-paseo-quote-editor],[data-paseo-quote-preview],[data-testid="agent-chat-scroll"]')) return false;
      return !!target.closest(hostSelector) || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(hostSelector) || node.querySelector(hostSelector)));
    })) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected", "data-testid", "class", "style", "aria-busy", "disabled", "readonly"] });
  const outside = (event: PointerEvent) => {
    if (preview && !event.composedPath().includes(preview.element) && !event.composedPath().includes(preview.projection.element)) closePreview(false);
    if (editor.kind !== "closed" && !editor.view.composing && !event.composedPath().includes(editor.view.element)) dismissEditor(editor.view, false);
  };
  const viewport = () => { schedule(); requestLayout(); };
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", viewport); window.addEventListener("scroll", requestLayout, true);
  type Capability = { kind: "ready"; host: DraftHost } | { kind: "unavailable"; reason: string };
  const ready = (options.discover ?? discoverDraftHost)(lifetime.signal).then((discovered): Capability => {
    if (lifetime.signal.aborted) return { kind: "unavailable", reason: "引用插件已关闭。" };
    host = discovered; unsubscribe = host.subscribe(schedule); schedule(); return { kind: "ready", host: discovered };
  }).catch((cause: unknown): Capability => ({ kind: "unavailable", reason: reason(cause) }));
  const externalAdds = new WeakMap<ExternalOffer, { recipient: StoreBinding; promise: Promise<AddResult> }>();
  function addPrepared(binding: DraftBinding, attachment: QuoteAttachment, prepare: () => Promise<QuoteAttachment>, input: { annotationKind: Promise<AnnotationKind>; openComment: boolean; focusComposer: boolean; valid: () => boolean; remember: (scope: string) => void }): Promise<AddResult> {
    const ref: QuoteRef = { id: attachment.item.id, binding };
    const view = input.openComment ? createEditor(ref, bindingElement(binding), { kind: "create", comment: "" }) : null;
    if (view) { editor = { kind: "create", view, phase: { kind: "adding" }, finishRequested: null }; view.field.focus({ preventScroll: true }); requestLayout(); }
    let inFlight: Promise<AddResult> | null = null;
    const perform = (): Promise<AddResult> => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let outcome: WriteOutcome;
        try {
          const [capability, prepared, kind] = await Promise.all([ready, prepare(), input.annotationKind]);
          const policy = await options.preferences?.check(kind);
          if (policy && !policy.allowed) outcome = { kind: "not-written", reason: policy.reason, fallback: false };
          else if (lifetime.signal.aborted || bindingStatus(binding) !== "ready" || !input.valid()) outcome = { kind: "not-written", reason: "原文或接收对话已切换，注释未添加。", fallback: false };
          else if (capability.kind === "unavailable") outcome = { kind: "not-written", reason: capability.reason, fallback: !isStoreBinding(binding) };
          else {
            input.remember(scopeOf(binding));
            if (view) view.scope = scopeOf(binding);
            outcome = await mutateQuotes({ host: capability.host, binding, change: { kind: "add", attachment: prepared }, isCurrent: () => !lifetime.signal.aborted && input.valid() && (!options.preferences || options.preferences.enabled(kind)) });
            if (outcome.kind !== "not-written") input.remember(scopeOf(binding));
          }
        } catch (cause) { outcome = { kind: "not-written", reason: reason(cause), fallback: false }; }
        if (view && editor.kind === "create" && editor.view === view && bindingStatus(binding) === "ready") {
          view.scope = scopeOf(binding);
          if (outcome.kind === "not-written" || (outcome.kind === "uncertain" && !quotesFor(binding).some((entry) => entry.item.id === ref.id))) {
            editor.phase = { kind: "add-error", retry: () => { if (editor.kind === "create" && editor.view === view) { editor.phase = { kind: "adding" }; void perform(); } } }; view.status.textContent = outcome.reason; view.retry.hidden = false;
          } else { editor.phase = { kind: "ready" }; view.status.textContent = outcome.kind === "uncertain" ? outcome.reason : ""; if (view.field.value) saveCreateComment(view); else if (editor.finishRequested) closeEditor(editor.finishRequested.focus); }
        } else if (view?.field.value && outcome.kind !== "not-written" && bindingStatus(binding) === "ready") void setComment(ref, view.field.value);
        if (!view && outcome.kind === "committed" && input.focusComposer && bindingStatus(binding) === "ready") bindingElement(binding).focus({ preventScroll: true });
        schedule();
        return outcome.kind === "not-written" ? outcome : { ...outcome, ref };
      })().finally(() => { inFlight = null; });
      return inFlight;
    };
    return perform();
  }
  return {
    add(input) {
      const binding = bindComposer(input.composer, input.anchor, input.agentId);
      if (!binding || binding.hostId !== options.owner.hostId) return Promise.resolve({ kind: "not-written", reason: "无法确定当前主机的输入框，引用未添加。", fallback: false });
      const attachment = makeQuote(input.formattedText, input.preview, window.location.href), source = captureSource(input.sourceRange, binding.anchor);
      return addPrepared(binding, attachment, async () => attachment, { annotationKind: Promise.resolve("chat"), openComment: input.openComment ?? false, focusComposer: input.focusComposer !== false, valid: () => true, remember: (scope) => sources.remember(scope, attachment.item.id, source) });
    },
    addExternal(offer, recipient) {
      const previous = externalAdds.get(offer);
      if (previous) return previous.recipient === recipient ? previous.promise : Promise.resolve({ kind: "not-written", reason: "此选区已指定接收对话，请重新选择原文。", fallback: false });
      if (!offer.recipients.includes(recipient) || !offer.validForAdd() || !recipient.validate()) return Promise.resolve({ kind: "not-written", reason: "原文或接收对话已变化。", fallback: false });
      const sourceUrl = window.location.href, attachment = makeQuote("", offer.label, sourceUrl);
      const prepared = offer.snapshot.then((snapshot) => {
        if (snapshot.origin.workspace.serverId !== options.owner.hostId) throw new Error("原文不属于当前插件主机，注释未添加。");
        const encoded = encodeExternal(snapshot, sourceUrl); return { ...attachment, item: { ...attachment.item, title: snapshot.title.slice(0, 128), url: encoded.url, text: encoded.text } };
      });
      const promise = addPrepared(recipient, attachment, () => prepared, { annotationKind: offer.snapshot.then((snapshot) => snapshot.origin.kind), openComment: true, focusComposer: false, valid: offer.validForAdd, remember: (scope) => sources.rememberExternal(scope, attachment.item.id, offer.source) });
      externalAdds.set(offer, { recipient, promise }); return promise;
    },
    observeExternal(listener) {
      let stop = () => {}, active = true;
      const cleanup = () => { active = false; stop(); sourceObservers.delete(cleanup); };
      sourceObservers.add(cleanup);
      void getSourceHost().then((host) => { if (active) stop = host.observe((selection) => {
        listener(currentHostId(window.location.href) === options.owner.hostId ? selection : null);
      }); }).catch((cause) => {
        if (!active) return;
        const unavailable = (event: Event) => {
          const element = event.target instanceof Element ? event.target : null;
          const root = element?.closest<HTMLElement>('[data-testid="workspace-file-pane"],[data-testid="git-diff-canvas-root"],[data-testid="terminal-surface"]');
          if (currentHostId(window.location.href) === options.owner.hostId && root && root.getClientRects().length) listener({ kind: "unavailable", root, reason: reason(cause) });
        };
        document.addEventListener("pointerup", unavailable, true); document.addEventListener("keyup", unavailable, true);
        stop = () => { document.removeEventListener("pointerup", unavailable, true); document.removeEventListener("keyup", unavailable, true); };
      });
      return cleanup;
    },
    setComment,
    dispose() {
      lifetime.abort(); unsubscribe(); observer.disconnect(); for (const cleanup of sourceObservers) cleanup(); sourceHost?.dispose();
      window.cancelAnimationFrame(frame); window.clearTimeout(closeTimer);
      document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", viewport); window.removeEventListener("scroll", requestLayout, true);
      closeEditor(false); closePreview(false);
      for (const projection of projections.values()) projection.element.remove();
      for (const markers of decorations.values()) for (const decoration of markers.values()) decoration.element.remove();
      projections.clear(); decorations.clear(); sources.dispose(); pending.clear();
      for (const element of hidden) if (element.getAttribute("data-paseo-quote-hidden") === marker) element.removeAttribute("data-paseo-quote-hidden");
      hidden.clear(); styles.remove();
    },
  };
}
