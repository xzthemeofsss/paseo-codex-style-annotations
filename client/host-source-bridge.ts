import { z } from "zod";
import { currentHostId, resolveModuleIds, reason, type InstallationOwner, type StoreBinding } from "./host-draft-bridge";
import { fingerprint, type ExternalOrigin, type ExternalSnapshot, type FileIdentity, type WorkspaceIdentity } from "./external-origin";
import type { ExternalLiveSource, SourceGeometry } from "./quote-sources";

const callable = z.custom<(...args: unknown[]) => unknown>((x) => typeof x === "function");
const nonempty = z.string().min(1);
const targetSchema = z.object({ kind: nonempty }).passthrough();
const tabSchema = z.object({ tabId: nonempty, target: targetSchema }).passthrough();
const paneContextSchema = z.object({ serverId: nonempty, workspaceId: nonempty, tabId: nonempty, target: targetSchema });
const mapSchema = z.custom<Map<string, unknown>>((x) => x instanceof Map);
const directorySchema = z.object({ agents: mapSchema, agentDetails: mapSchema, workspaces: mapSchema }).passthrough();
const layoutSchema = z.object({ root: z.unknown(), focusedPaneId: z.string().nullable().optional(), parentTabIdByTabId: z.record(z.string(), z.string()).optional() }).passthrough();
const storeSchema = z.object({ layoutByWorkspace: z.record(z.string(), z.unknown()), sheetsByWorkspace: z.record(z.string(), z.array(z.object({ tab: tabSchema, parentTabId: z.string().nullable().optional() }).passthrough())) }).passthrough();
const routeSchema = z.object({ serverId: nonempty, workspaceId: nonempty });
const positionSchema = z.object({ fileIndex: z.number().int().nonnegative(), rowIndex: z.number().int().nonnegative(), cellIndex: z.number().int().nonnegative(), side: z.enum(["old", "new"]), sourceOffset: z.number().int().nonnegative() });
const selectionSchema = z.object({ anchor: positionSchema, focus: positionSchema });
const pointSchema = z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() });
const terminalPositionSchema = z.object({ start: pointSchema, end: pointSchema });
export const SOURCE_MODULE_SIGNATURES = {
  routes: ["parseHostWorkspaceRouteFromPathname", "decodeWorkspaceIdFromPathSegment"],
  workspaceIdentity: ["normalizeWorkspaceOpaqueId", "resolveWorkspaceMapKeyByIdentity"],
  workspaceKey: ["buildWorkspaceTabPersistenceKey"],
  workspaceSelectors: ["selectWorkspaceDirectory", "selectWorkspaceExists"],
  layout: ["useWorkspaceLayoutStore", "collectAllTabs", "findPaneById"],
  sessions: ["useSessionStore", "normalizeWorkspaceDescriptor"],
  pane: ["PaneProvider", "usePaneContext", "PaneFocusProvider"],
  keys: ["buildDraftStoreKey", "buildNewWorkspaceDraftKey"],
};
const CAPABILITIES = {
  paths: { paths: ["normalizeWorkspaceFileLocation", "resolveWorkspaceFilePaths", "createWorkspaceFileTabTarget"] },
  opener: { opener: ["openWorkspaceTargetAtLocation", "openWorkspaceTargetBeside"] },
  editor: { editor: ["EditorView", "Decoration", "ViewPlugin"] },
  diff: { diff: ["DiffSurface"], diffSelection: ["orderedSelection", "selectedSourceText", "selectCellSource"] },
};
function field(value: unknown, key: string): unknown { return value !== null && (typeof value === "object" || typeof value === "function") ? Reflect.get(value, key) : undefined; }
function functions(value: unknown, names: string[]) { return z.record(z.string(), callable).parse(Object.fromEntries(names.map((name) => [name, field(value, name)]))); }
function store(value: unknown) { return functions(value, ["getState", "subscribe"]); }
function visible(root: HTMLElement): boolean { return root.isConnected && root.getClientRects().length > 0 && !root.closest('[aria-hidden="true"]'); }
function sameTarget(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

interface Fiber { type: unknown; stateNode: unknown; memoizedProps: unknown; memoizedState: unknown; updateQueue: unknown; child: unknown; sibling: unknown; return: unknown }
const fiberSchema = z.custom<Fiber>((value) => !!value && typeof value === "object" && "memoizedProps" in value && "return" in value);
export function currentFibers(root: HTMLElement): Array<{ fiber: Fiber; ancestors: Fiber[] }> {
  const keys = Object.getOwnPropertyNames(root).filter((key) => key.startsWith("__reactFiber$"));
  if (keys.length !== 1) throw new Error("无法验证原文组件。");
  let seed = fiberSchema.parse(field(root, keys[0]));
  let depth = 0;
  while (seed.return) { if (++depth > 1000) throw new Error("原文组件层级异常。"); seed = fiberSchema.parse(seed.return); }
  const current = fiberSchema.parse(field(seed.stateNode, "current"));
  const stack = [{ fiber: current, ancestors: [] as Fiber[] }], result: Array<{ fiber: Fiber; ancestors: Fiber[] }> = [], seen = new Set<Fiber>();
  while (stack.length) {
    const entry = stack.pop(); if (!entry || seen.has(entry.fiber)) continue;
    seen.add(entry.fiber); if (seen.size > 100_000) throw new Error("原文组件数量异常。");
    result.push(entry);
    if (entry.fiber.sibling) stack.push({ fiber: fiberSchema.parse(entry.fiber.sibling), ancestors: entry.ancestors });
    if (entry.fiber.child) stack.push({ fiber: fiberSchema.parse(entry.fiber.child), ancestors: [...entry.ancestors, entry.fiber] });
  }
  return result;
}
function hooks(fiber: Fiber): unknown[] {
  const result: unknown[] = [];
  for (let hook = fiber.memoizedState; hook; hook = field(hook, "next")) {
    if (result.length > 1000) throw new Error("原文组件状态异常。");
    result.push(field(hook, "memoizedState"));
  }
  return result;
}
export interface ExternalOffer {
  readonly label: string;
  readonly selectionToken: object;
  readonly root: HTMLElement;
  readonly snapshot: Promise<ExternalSnapshot>;
  readonly recipients: readonly StoreBinding[];
  readonly preferred: StoreBinding | null;
  readonly source: ExternalLiveSource;
  readonly validForAdd: () => boolean;
}
export type ExternalSelection = { kind: "offer"; offer: ExternalOffer } | { kind: "unavailable"; root: HTMLElement; reason: string } | null;
export interface SourceHost {
  capture(target?: EventTarget | null): ExternalSelection;
  observe(listener: (selection: ExternalSelection) => void): () => void;
  reveal(snapshot: ExternalSnapshot): Promise<{ kind: "highlighted" } | { kind: "opened"; reason: string } | { kind: "unavailable"; reason: string }>;
  dispose(): void;
}

export function createSourceHost(requireModule: (id: number) => unknown, source: string, installationOwner: InstallationOwner): SourceHost {
  const ids = resolveModuleIds(source, SOURCE_MODULE_SIGNATURES);
  const routes = functions(requireModule(ids.routes), ["parseHostWorkspaceRouteFromPathname"]);
  const identity = functions(requireModule(ids.workspaceIdentity), ["resolveWorkspaceMapKeyByIdentity"]);
  const workspaceKeys = functions(requireModule(ids.workspaceKey), ["buildWorkspaceTabPersistenceKey"]);
  const selectors = functions(requireModule(ids.workspaceSelectors), ["selectWorkspaceDirectory"]);
  const layoutModule = requireModule(ids.layout), layout = functions(layoutModule, ["collectAllTabs", "findPaneById"]), layoutStore = store(field(layoutModule, "useWorkspaceLayoutStore"));
  const sessions = store(field(requireModule(ids.sessions), "useSessionStore"));
  const PaneProvider = callable.parse(field(requireModule(ids.pane), "PaneProvider"));
  const keys = functions(requireModule(ids.keys), ["buildDraftStoreKey"]);
  const capabilities = new Map<string, unknown>();
  const capability = (name: keyof typeof CAPABILITIES): Record<string, number> => {
    if (!capabilities.has(name)) {
      try { capabilities.set(name, resolveModuleIds(source, CAPABILITIES[name])); } catch (error) { capabilities.set(name, error); }
    }
    const value = capabilities.get(name); if (value instanceof Error) throw value;
    return z.record(z.string(), z.number()).parse(value);
  };
  const pathFunctions = () => functions(requireModule(capability("paths").paths), ["resolveWorkspaceFilePaths", "normalizeWorkspaceFileLocation", "createWorkspaceFileTabTarget"]);
  let disposed = false, contextRevision = 0;
  const scope = (context?: z.infer<typeof paneContextSchema>): WorkspaceIdentity => {
    const route = routeSchema.parse(routes.parseHostWorkspaceRouteFromPathname(window.location.pathname));
    if (route.serverId !== installationOwner.hostId) throw new Error("原文不属于当前插件主机。");
    const state = z.object({ sessions: z.record(z.string(), z.unknown()) }).parse(sessions.getState());
    const session = directorySchema.parse(state.sessions[route.serverId]);
    const workspaceId = nonempty.parse(identity.resolveWorkspaceMapKeyByIdentity({ workspaces: session.workspaces, workspaceId: route.workspaceId }));
    if (context && (context.serverId !== route.serverId || identity.resolveWorkspaceMapKeyByIdentity({ workspaces: session.workspaces, workspaceId: context.workspaceId }) !== workspaceId)) throw new Error("原文不属于当前工作区。");
    const workspaceKey = nonempty.parse(workspaceKeys.buildWorkspaceTabPersistenceKey({ serverId: route.serverId, workspaceId }));
    const root = nonempty.parse(selectors.selectWorkspaceDirectory(state, route.serverId, workspaceId));
    return { serverId: route.serverId, workspaceId, workspaceKey, root };
  };
  const directory = (workspace: WorkspaceIdentity) => {
    const state = z.object({ sessions: z.record(z.string(), z.unknown()) }).parse(sessions.getState());
    return directorySchema.parse(state.sessions[workspace.serverId]);
  };
  const tabs = (workspace: WorkspaceIdentity) => {
    const state = storeSchema.parse(layoutStore.getState()), tree = layoutSchema.parse(state.layoutByWorkspace[workspace.workspaceKey]);
    return { tabs: [...z.array(tabSchema).parse(layout.collectAllTabs(tree.root)), ...(state.sheetsByWorkspace[workspace.workspaceKey] ?? []).map((sheet) => sheet.tab)], parents: { ...tree.parentTabIdByTabId, ...Object.fromEntries((state.sheetsByWorkspace[workspace.workspaceKey] ?? []).filter((sheet) => sheet.parentTabId).map((sheet) => [sheet.tab.tabId, sheet.parentTabId])) } };
  };
  const focusHistory = new Map<string, string[]>();
  let lastFocus: string | null = null;
  const sampleFocus = () => {
    if (disposed) return;
    try {
      const workspace = scope(), state = storeSchema.parse(layoutStore.getState());
      const tree = layoutSchema.parse(state.layoutByWorkspace[workspace.workspaceKey]);
      const pane = z.object({ focusedTabId: z.string().nullable() }).nullable().parse(layout.findPaneById(tree.root, tree.focusedPaneId));
      const tab = pane && z.array(tabSchema).parse(layout.collectAllTabs(tree.root)).find((item) => item.tabId === pane.focusedTabId);
      const agentId = tab?.target.kind === "agent" ? nonempty.parse(field(tab.target, "agentId")) : null;
      const focus = JSON.stringify([workspace.workspaceKey, pane?.focusedTabId ?? null, agentId]);
      if (focus === lastFocus) return;
      lastFocus = focus;
      if (!agentId) return;
      const history = focusHistory.get(workspace.workspaceKey) ?? [];
      focusHistory.set(workspace.workspaceKey, [agentId, ...history.filter((id) => id !== agentId)]);
    } catch { lastFocus = null; }
  };
  const unlayoutContext = callable.parse(layoutStore.subscribe(() => { contextRevision++; sampleFocus(); }));
  const unsessionContext = callable.parse(sessions.subscribe(() => { contextRevision++; }));
  let routePathname = window.location.pathname;
  const reconcileRoute = () => {
    if (window.location.pathname !== routePathname) { routePathname = window.location.pathname; contextRevision++; }
    sampleFocus();
  };
  window.addEventListener("popstate", reconcileRoute);
  window.addEventListener("hashchange", reconcileRoute);
  sampleFocus();
  const contextFor = (root: HTMLElement, entry?: { fiber: Fiber; ancestors: Fiber[] }) => {
    const found = entry ?? currentFibers(root).find(({ fiber }) => fiber.stateNode === root);
    if (!found) throw new Error("无法确认原文所属标签。");
    const providers = found.ancestors.filter((fiber) => fiber.type === PaneProvider);
    if (providers.length !== 1) throw new Error("原文所属标签不明确。");
    const context = paneContextSchema.parse(field(providers[0].memoizedProps, "value")), workspace = scope(context);
    const tab = tabs(workspace).tabs.find((candidate) => candidate.tabId === context.tabId);
    if (!tab || !sameTarget(tab.target, context.target)) throw new Error("原文标签已切换。");
    return { context, workspace };
  };
  const scopeValid = (workspace: WorkspaceIdentity) => {
    try { return !disposed && sameTarget(scope(), workspace); } catch { return false; }
  };
  const sourceGuard = (root: HTMLElement, captured: ReturnType<typeof contextFor>) => {
    let checkedRevision = -1, current = false;
    return () => {
      if (!visible(root) || !scopeValid(captured.workspace)) return false;
      if (checkedRevision !== contextRevision) {
        checkedRevision = contextRevision;
        try { current = sameTarget(contextFor(root), captured); } catch { current = false; }
      }
      return current;
    };
  };
  const recipients = (root: HTMLElement, captured: ReturnType<typeof contextFor>) => {
    const { workspace, context } = captured, session = directory(workspace), sourceTabs = tabs(workspace);
    const agents = new Map([...session.agentDetails, ...session.agents]);
    const result: StoreBinding[] = [];
    for (const [agentId, raw] of agents) {
      const agent = z.object({ workspaceId: nonempty, title: z.string().nullable().optional(), name: z.string().nullable().optional() }).passthrough().safeParse(raw);
      if (!agent.success || identity.resolveWorkspaceMapKeyByIdentity({ workspaces: session.workspaces, workspaceId: agent.data.workspaceId }) !== workspace.workspaceId) continue;
      const draftKey = nonempty.parse(keys.buildDraftStoreKey({ serverId: workspace.serverId, agentId }));
      const pane = root.closest('[data-testid^="workspace-pane-"]');
      const binding: StoreBinding = { kind: "store", hostId: workspace.serverId, agentId, draftKey, label: agent.data.title || agent.data.name || agentId, anchor: root, pane: pane instanceof HTMLElement ? pane : root,
        validate: () => {
          if (!scopeValid(workspace)) return false;
          const latest = directory(workspace), current = latest.agents.get(agentId) ?? latest.agentDetails.get(agentId);
          return field(current, "workspaceId") !== undefined && identity.resolveWorkspaceMapKeyByIdentity({ workspaces: latest.workspaces, workspaceId: field(current, "workspaceId") }) === workspace.workspaceId
            && keys.buildDraftStoreKey({ serverId: workspace.serverId, agentId }) === draftKey;
        } };
      result.push(binding);
    }
    const parentId = sourceTabs.parents[context.tabId], parent = sourceTabs.tabs.find((tab) => tab.tabId === parentId);
    result.sort((a, b) => a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0);
    const history = (focusHistory.get(workspace.workspaceKey) ?? []).filter((id) => result.some((binding) => binding.agentId === id));
    focusHistory.set(workspace.workspaceKey, history);
    const recent = result.find((binding) => binding.agentId === history[0]);
    const parentBinding = parent?.target.kind === "agent" ? result.find((binding) => binding.agentId === field(parent.target, "agentId")) : undefined;
    const preferred = recent ?? parentBinding ?? result[0] ?? null;
    return { recipients: result, preferred };
  };
  const fileIdentity = (path: unknown, workspace: WorkspaceIdentity): FileIdentity => {
    const requestedPath = nonempty.parse(path), resolved = z.object({ absolutePath: nonempty, relativePath: z.string().nullable() }).nullable().parse(pathFunctions().resolveWorkspaceFilePaths({ path: requestedPath, workspaceRoot: workspace.root }));
    return { requestedPath, absolutePath: resolved?.absolutePath ?? null, relativePath: resolved?.relativePath ?? null };
  };
  const geometry = (root: HTMLElement): SourceGeometry => {
    if (!visible(root)) return { kind: "unavailable" };
    const r = root.getBoundingClientRect(), left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    return right > left && bottom > top ? { kind: "visible", rects: [new DOMRect(left, top, right - left, Math.min(22, bottom - top))], bounds: { left, right, top, bottom } } : { kind: "offscreen" };
  };
  const selections = new WeakMap<HTMLElement, { evidence: readonly unknown[]; token: object }>();
  const makeOffer = (root: HTMLElement, captured: ReturnType<typeof contextFor>, evidence: readonly unknown[], snapshot: Promise<ExternalSnapshot>, valid: () => boolean, liveGeometry: () => SourceGeometry, reveal: ExternalLiveSource["reveal"]): ExternalSelection => {
    void snapshot.catch(() => {});
    const identity = [captured.workspace.workspaceKey, captured.context.tabId, JSON.stringify(captured.context.target), ...evidence];
    const previous = selections.get(root);
    const selectionToken = previous && identity.length === previous.evidence.length && identity.every((value, index) => Object.is(value, previous.evidence[index])) ? previous.token : {};
    selections.set(root, { evidence: identity, token: selectionToken });
    return { kind: "offer", offer: { root, selectionToken, label: captured.context.target.kind, snapshot, ...recipients(root, captured), validForAdd: valid, source: { valid, geometry: () => { try { return liveGeometry(); } catch { return { kind: "unavailable" }; } }, reveal } } };
  };

  const captureFile = (root: HTMLElement): ExternalSelection => {
    const captured = contextFor(root), valid = sourceGuard(root, captured), { context, workspace } = captured;
    if (context.target.kind !== "file") throw new Error("原文文件标签无法验证。");
    const file = fileIdentity(field(context.target, "path"), workspace);
    const selectedPreview = root.querySelector('[data-testid="markdown-preview-frame"]'), browserSelection = window.getSelection();
    const previewSelected = selectedPreview instanceof HTMLElement && visible(selectedPreview) && browserSelection && !browserSelection.isCollapsed && browserSelection.rangeCount === 1 && selectedPreview.contains(browserSelection.getRangeAt(0).startContainer) && selectedPreview.contains(browserSelection.getRangeAt(0).endContainer);
    const editorRoot = root.matches('[data-testid="file-source-editor"]') ? root : root.querySelector('[data-testid="file-source-editor"]');
    if (editorRoot instanceof HTMLElement && visible(editorRoot) && !previewSelected) {
      const moduleIds = capability("editor"), EditorView = field(requireModule(moduleIds.editor), "EditorView"), find = callable.parse(field(EditorView, "findFromDOM"));
      const cm = editorRoot.querySelector(".cm-content") ?? editorRoot.querySelector(".cm-editor");
      if (!cm) return null;
      const view = find.call(EditorView, cm);
      const read = () => {
        const state = z.object({ selection: z.object({ ranges: z.array(z.unknown()), main: z.object({ from: z.number().int(), to: z.number().int() }) }) }).passthrough().parse(field(view, "state"));
        const doc = field(field(view, "state"), "doc"), slice = callable.parse(field(doc, "sliceString")), lineAt = callable.parse(field(doc, "lineAt")), toString = callable.parse(field(doc, "toString"));
        return { state, doc, slice, lineAt, content: z.string().parse(toString.call(doc)) };
      };
      const { state, doc, slice, lineAt, content } = read(), { from, to } = state.selection.main;
      if (state.selection.ranges.length !== 1) throw new Error("暂不支持多个不连续的代码选区。");
      if (from === to) return null;
      const text = z.string().parse(slice.call(doc, from, to)), lineStart = z.object({ number: z.number().int().positive() }).parse(lineAt.call(doc, from)).number, lineEnd = z.object({ number: z.number().int().positive() }).parse(lineAt.call(doc, to - 1)).number;
      const snapshot = fingerprint(content).then((version): ExternalSnapshot => ({ text, title: `${file.requestedPath}:${lineStart}-${lineEnd}`, origin: { kind: "file", workspace, tabId: context.tabId, file, from, to, lineStart, lineEnd, version } }));
      const sourceValid = () => valid() && field(view, "dom") instanceof HTMLElement && root.contains(z.instanceof(HTMLElement).parse(field(view, "dom")));
      const exact = () => { try { return sourceValid() && read().content === content; } catch { return false; } };
      const editorGeometry = () => {
        if (!exact()) return { kind: "unavailable" } satisfies SourceGeometry;
        const coords = callable.parse(field(view, "coordsAtPos")), a = coords.call(view, from), b = coords.call(view, to), bounds = geometry(root);
        if (bounds.kind !== "visible" || !a || !b) return geometry(root);
        const pa = z.object({ left: z.number(), top: z.number(), bottom: z.number() }).parse(a), pb = z.object({ right: z.number(), top: z.number(), bottom: z.number() }).parse(b);
        const top = Math.max(pa.top, bounds.bounds.top), bottom = Math.min(pb.bottom, bounds.bounds.bottom);
        return bottom > top ? { ...bounds, rects: [new DOMRect(Math.max(bounds.bounds.left, pa.left), top, Math.max(1, Math.min(bounds.bounds.right, pb.right) - pa.left), bottom - top)] } : { kind: "offscreen" } satisfies SourceGeometry;
      };
      return makeOffer(root, captured, [view, doc, from, to], snapshot, sourceValid, editorGeometry, async () => {
        if (!exact()) return { kind: "unavailable", reason: "文件内容或编辑器已变化，原文位置不可用。" };
        const dispatch = callable.parse(field(view, "dispatch")); dispatch.call(view, { selection: { anchor: from, head: to }, scrollIntoView: true });
        return { kind: "highlighted" };
      });
    }
    const preview = root.matches('[data-testid="markdown-preview-frame"]') ? root : root.querySelector('[data-testid="markdown-preview-frame"]'), selection = window.getSelection();
    if (!(preview instanceof HTMLElement) || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (!preview.contains(range.startContainer) || !preview.contains(range.endContainer)) return null;
    const text = range.toString(); if (!text.length) return null;
    const content = preview.textContent ?? "", start = range.startContainer, end = range.endContainer, startOffset = range.startOffset, endOffset = range.endOffset;
    const exact = () => valid() && preview.textContent === content && range.startContainer === start && range.endContainer === end && range.startOffset === startOffset && range.endOffset === endOffset && range.toString() === text;
    const snapshot = fingerprint(content).then((version): ExternalSnapshot => ({ text, title: `${file.requestedPath} · Markdown`, origin: { kind: "markdown", workspace, tabId: context.tabId, file, version } }));
    const markdownGeometry = (): SourceGeometry => {
      if (!exact()) return { kind: "unavailable" };
      const bounds = geometry(preview); if (bounds.kind !== "visible") return bounds;
      const pane = root.getBoundingClientRect();
      let left = Math.max(bounds.bounds.left, pane.left), right = Math.min(bounds.bounds.right, pane.right), top = Math.max(bounds.bounds.top, pane.top), bottom = Math.min(bounds.bounds.bottom, pane.bottom);
      for (let ancestor: HTMLElement | null = preview; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
        if (style.overflowX !== "visible") { left = Math.max(left, rect.left + ancestor.clientLeft); right = Math.min(right, rect.left + ancestor.clientLeft + ancestor.clientWidth); }
        if (style.overflowY !== "visible") { top = Math.max(top, rect.top + ancestor.clientTop); bottom = Math.min(bottom, rect.top + ancestor.clientTop + ancestor.clientHeight); }
      }
      if (right <= left || bottom <= top) return { kind: "offscreen" };
      const rects = Array.from(range.getClientRects(), (rect) => {
        const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
        return new DOMRect(x, y, Math.min(right, rect.right) - x, Math.min(bottom, rect.bottom) - y);
      }).filter((rect) => rect.width > 0 && rect.height > 0);
      return rects.length ? { kind: "visible", rects, bounds: { left, right, top, bottom } } : { kind: "offscreen" };
    };
    return makeOffer(root, captured, [preview, content, start, end, startOffset, endOffset], snapshot, valid, markdownGeometry, async () => {
      if (!exact()) return { kind: "unavailable", reason: "Markdown 预览已变化，原文位置不可用。" };
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      for (let ancestor = preview.parentElement; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect(), selected = range.getBoundingClientRect();
        if (/auto|scroll/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight) ancestor.scrollTop += selected.top - rect.top - ancestor.clientTop - Math.min(40, ancestor.clientHeight / 4);
        if (/auto|scroll/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth) ancestor.scrollLeft += selected.left - rect.left - ancestor.clientLeft;
      }
      return markdownGeometry().kind === "visible" ? { kind: "highlighted" } : { kind: "unavailable", reason: "Markdown 原文仍在预览可见区域外。" };
    });
  };

  // Scanning the whole bundle takes ~100 ms and the scan loop calls this on DOM mutations, so resolve once.
  // Only a signature mismatch is cached as a failure; anything else (e.g. out of memory) is retried.
  let terminalIdsResult: Record<string, number> | ModuleSignatureMismatch | undefined;
  const terminalIds = () => {
    if (!terminalIdsResult) {
      try {
        terminalIdsResult = resolveSemanticModuleIds(source, {
          terminalComponent: ["data-terminal-scrollbar-root", "onRendererReadyChange", "useDOMImperativeHandle"],
          terminalRuntime: ["TerminalEmulatorRuntime", "createTerminalResizeEvent", "encodeTerminalOutput", "window.__paseoTerminal"],
          terminalPane: ["TerminalPane=function", "getWorkspaceTerminalSession", "onOpenWorkspaceFile", "terminal-surface"],
        });
      } catch (error) {
        if (error instanceof ModuleSignatureMismatch) terminalIdsResult = error;
        throw error;
      }
    }
    if (terminalIdsResult instanceof ModuleSignatureMismatch) throw terminalIdsResult;
    return terminalIdsResult;
  };
  interface Terminal {
    element: HTMLElement; cols: number; rows: number;
    getSelection(): string; hasSelection(): boolean; getSelectionPosition(): z.infer<typeof terminalPositionSchema> | undefined;
    buffer: { active: { type: "normal" | "alternate"; length: number; baseY: number; viewportY: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } };
    onSelectionChange(listener: () => void): { dispose(): void }; onScroll(listener: () => void): { dispose(): void }; onWriteParsed(listener: () => void): { dispose(): void }; onResize(listener: () => void): { dispose(): void };
    scrollToLine(y: number): void; select(x: number, y: number, length: number): void;
  }
  const terminalSchema = z.custom<Terminal>((value) => {
    try { const names = ["getSelection", "hasSelection", "getSelectionPosition", "onSelectionChange", "onScroll", "onWriteParsed", "onResize", "scrollToLine", "select"]; functions(value, names); return field(value, "element") instanceof HTMLElement && z.number().int().positive().safeParse(field(value, "cols")).success && z.number().int().positive().safeParse(field(value, "rows")).success; } catch { return false; }
  });
  const terminalEpochs = new Map<Terminal, { epoch: number; dispose(): void }>();
  const trackTerminal = (terminal: Terminal) => {
    let entry = terminalEpochs.get(terminal);
    if (!entry) {
      const epoch = { epoch: 0, dispose: () => {} };
      const write = terminal.onWriteParsed(() => { epoch.epoch++; }), resize = terminal.onResize(() => { epoch.epoch++; });
      epoch.dispose = () => { write.dispose(); resize.dispose(); }; terminalEpochs.set(terminal, epoch); entry = epoch;
    }
    return entry;
  };
  const terminalStreams = new WeakMap<object, string>();
  const terminalBinding = (root: HTMLElement) => {
    const ids = terminalIds(), Component = callable.parse(field(requireModule(ids.terminalComponent), "default")), Runtime = callable.parse(field(requireModule(ids.terminalRuntime), "TerminalEmulatorRuntime")), TerminalPane = callable.parse(field(requireModule(ids.terminalPane), "TerminalPane"));
    const matches = currentFibers(root).flatMap((entry) => {
      if (entry.fiber.type !== Component) return [];
      return hooks(entry.fiber).flatMap((hook) => {
        const runtime = field(hook, "current");
        if (!(runtime instanceof Runtime)) return [];
        const terminal = terminalSchema.safeParse(field(runtime, "terminal"));
        return terminal.success && root.contains(terminal.data.element) ? [{ ...entry, runtime, terminal: terminal.data }] : [];
      });
    });
    if (matches.length !== 1) throw new Error("终端选择接口不明确。");
    const match = matches[0], parents = match.ancestors.filter((fiber) => fiber.type === TerminalPane);
    if (parents.length !== 1) throw new Error("无法验证终端所属会话。");
    const parent = z.object({ serverId: nonempty, cwd: nonempty, terminalId: nonempty }).parse(parents[0].memoizedProps), streamKey = nonempty.parse(field(match.fiber.memoizedProps, "streamKey"));
    if (streamKey !== `${parent.serverId}:${parent.cwd}:${parent.terminalId}`) throw new Error("终端会话已变化。");
    const captured = contextFor(root, match);
    if (captured.context.target.kind !== "terminal" || field(captured.context.target, "terminalId") !== parent.terminalId) throw new Error("终端标签已切换。");
    const previousStream = terminalStreams.get(match.runtime);
    if (previousStream && previousStream !== streamKey) throw new Error("终端正在切换，请重新选择输出。");
    terminalStreams.set(match.runtime, streamKey);
    if (captured.workspace.serverId !== parent.serverId || captured.workspace.root !== parent.cwd) throw new Error("终端不属于当前工作区。");
    trackTerminal(match.terminal);
    return { ...match, ...parent, streamKey, captured };
  };
  const captureTerminal = (root: HTMLElement): ExternalSelection => {
    const binding = terminalBinding(root), { terminal, captured } = binding;
    if (!terminal.hasSelection()) return null;
    const text = terminal.getSelection(), position = terminalPositionSchema.parse(terminal.getSelectionPosition()); if (!text.length) return null;
    const buffer = terminal.buffer.active, bufferType = z.enum(["normal", "alternate"]).parse(buffer.type), cols = terminal.cols, rows = terminal.rows;
    const evidence = () => JSON.stringify({ type: terminal.buffer.active.type, length: terminal.buffer.active.length, baseY: terminal.buffer.active.baseY, cols: terminal.cols, rows: terminal.rows, lines: Array.from({ length: position.end.y - position.start.y + 1 }, (_, i) => terminal.buffer.active.getLine(position.start.y + i)?.translateToString(false) ?? null) });
    if (position.end.y < position.start.y || position.end.y - position.start.y > 20_000) throw new Error("终端选区过长，无法验证定位。");
    const contextValid = sourceGuard(root, captured);
    const content = evidence(), writeEpoch = trackTerminal(terminal).epoch, valid = () => {
      if (!visible(root)) return false;
      try { const next = terminalBinding(root); return visible(root) && next.runtime === binding.runtime && next.terminal === terminal && next.streamKey === binding.streamKey && sameTarget(next.captured, captured); } catch { return false; }
    };
    const snapshot = fingerprint(content).then((version): ExternalSnapshot => ({ text, title: `终端 ${binding.terminalId} · 缓冲区 ${position.start.y + 1}-${position.end.y + 1}`, origin: { kind: "terminal", workspace: captured.workspace, tabId: captured.context.tabId, terminalId: binding.terminalId, cwd: binding.cwd, streamKey: binding.streamKey, buffer: bufferType, start: position.start, end: position.end, cols, rows, version } }));
    const terminalGeometry = (): SourceGeometry => {
      if (!contextValid() || field(binding.runtime, "terminal") !== terminal || !root.contains(terminal.element) || evidence() !== content || trackTerminal(terminal).epoch !== writeEpoch) return { kind: "unavailable" };
      const screen = root.querySelector(".xterm-screen"); if (!(screen instanceof HTMLElement)) return { kind: "unavailable" };
      const box = screen.getBoundingClientRect(), cellWidth = box.width / cols, cellHeight = box.height / rows, viewport = terminal.buffer.active.viewportY, rects: DOMRect[] = [];
      for (let y = position.start.y; y <= position.end.y; y++) {
        const start = y === position.start.y ? position.start.x : 0, end = y === position.end.y ? position.end.x : cols;
        const top = box.top + (y - viewport) * cellHeight, bottom = Math.min(box.bottom, top + cellHeight);
        if (end > start && top >= box.top && bottom > top && top < box.bottom) rects.push(new DOMRect(box.left + start * cellWidth, top, (end - start) * cellWidth, bottom - top));
      }
      return rects.length ? { kind: "visible", rects, bounds: { left: Math.max(0, box.left), right: Math.min(innerWidth, box.right), top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom) } } : { kind: "offscreen" };
    };
    return makeOffer(root, captured, [binding.runtime, terminal, buffer, writeEpoch, content, text, position.start.x, position.start.y, position.end.x, position.end.y], snapshot, valid, terminalGeometry, async () => {
      if (!valid() || evidence() !== content || trackTerminal(terminal).epoch !== writeEpoch) return { kind: "unavailable", reason: "终端缓冲区或会话已变化，原文位置不可用。" };
      terminal.scrollToLine(position.start.y); terminal.select(position.start.x, position.start.y, (position.end.y - position.start.y) * cols + position.end.x - position.start.x);
      if (terminal.getSelection() !== text) return { kind: "unavailable", reason: "终端原文校验失败。" };
      return { kind: "highlighted" };
    });
  };

  interface DiffCell { content: string; type: string; lineNumber: number | null; sourceIdentity: { hunkIndex: number; lineIndex: number; side: "old" | "new" } | null; reviewTarget: { filePath: string; side: "old" | "new"; oldLineNumber: number | null; newLineNumber: number | null; lineNumber: number; content: string; hunkIndex: number; lineIndex: number } | null }
  interface DiffModel { files: Array<{ path: string; file: { path: string; oldPath?: string; isNew: boolean; isDeleted: boolean; hunks: unknown[] } }>; rows: Array<{ kind: string; path: string; fileIndex: number; cells: Array<DiffCell | null> }>; layout: "split" | "unified" }
  const diffModelSchema = z.custom<DiffModel>((value) => z.object({ files: z.array(z.object({ path: nonempty, file: z.object({ path: nonempty, oldPath: z.string().optional(), isNew: z.boolean(), isDeleted: z.boolean(), hunks: z.array(z.unknown()) }).passthrough() }).passthrough()), rows: z.array(z.object({ kind: z.string() }).passthrough()), layout: z.enum(["split", "unified"]) }).safeParse(value).success);
  const diffBinding = (root: HTMLElement) => {
    const ids = capability("diff"), Component = callable.parse(field(requireModule(ids.diff), "DiffSurface")), canvas = root.querySelector('[data-testid="git-diff-canvas"]'), scroll = root.querySelector('[data-testid="git-diff-scroll"]');
    if (!(canvas instanceof HTMLCanvasElement) || !(scroll instanceof HTMLElement)) throw new Error("Diff 画布接口已变化。");
    const matches = currentFibers(root).flatMap((entry) => {
      if (entry.fiber.type !== Component) return [];
      const values = hooks(entry.fiber), result: Array<{ entry: typeof entry; model: DiffModel; selection: unknown; modelRef: unknown; selectionRef: unknown; offsets: Map<unknown, unknown>; scroll: HTMLElement }> = [];
      for (let i = 0; i + 10 < values.length; i++) {
        const refs = values.slice(i, i + 11); if (!refs.every((value) => typeof value === "object" && value !== null && Object.hasOwn(value, "current"))) continue;
        const v = refs.map((value) => field(value, "current"));
        if (v[0] !== root || v[1] !== canvas || v[4] !== scroll || !Array.isArray(v[2]) || v[2].length !== 2 || !(v[9] instanceof Map) || v[5] !== v[6]) continue;
        const model = diffModelSchema.safeParse(v[5]), propsFiles = field(entry.fiber.memoizedProps, "files");
        if (!model.success || !Array.isArray(propsFiles) || model.data.files.length !== propsFiles.length || !model.data.files.every((file, i) => file.file === propsFiles[i])) continue;
        result.push({ entry, model: model.data, selection: v[10], modelRef: refs[5], selectionRef: refs[10], offsets: v[9], scroll });
      }
      return result;
    });
    if (matches.length !== 1) throw new Error("Diff 原文模型接口不明确。");
    const match = matches[0], captured = contextFor(root, match.entry);
    return { ...match, captured, helpers: functions(requireModule(ids.diffSelection), ["orderedSelection", "selectedSourceText", "selectionRectangles"]) };
  };
  const captureDiff = (root: HTMLElement): ExternalSelection => {
    const binding = diffBinding(root), { model, captured, helpers } = binding;
    if (!binding.selection) return null;
    const selection = selectionSchema.parse(binding.selection), ordered = z.object({ start: positionSchema, end: positionSchema }).parse(helpers.orderedSelection(selection)), { start, end } = ordered;
    const text = z.string().parse(helpers.selectedSourceText(model, selection)); if (!text.length) return null;
    if (start.fileIndex !== end.fileIndex) throw new Error("暂不支持跨文件 Diff 选区。");
    const cells: Array<{ cell: DiffCell; path: string; fileIndex: number; from: number; to: number }> = [], oneColumn = model.layout === "split" && start.cellIndex === end.cellIndex;
    const compare = (a: { rowIndex: number; cellIndex: number }, b: { rowIndex: number; cellIndex: number }) => a.rowIndex - b.rowIndex || a.cellIndex - b.cellIndex;
    for (const endpoint of [start, end]) {
      const row = model.rows[endpoint.rowIndex], cell = row?.cells?.[endpoint.cellIndex];
      if (!row || row.fileIndex !== endpoint.fileIndex || !cell || endpoint.sourceOffset > cell.content.length || cell.sourceIdentity?.side !== endpoint.side) throw new Error("Diff 选区已变化。");
    }
    for (let rowIndex = start.rowIndex; rowIndex <= end.rowIndex; rowIndex++) {
      const row = model.rows[rowIndex]; if (!row || row.kind !== "line" || !Array.isArray(row.cells)) throw new Error("请选择连续的 Diff 代码行。");
      row.cells.forEach((cell, cellIndex) => {
        if (!cell || oneColumn && cellIndex !== start.cellIndex || compare({ rowIndex, cellIndex }, start) < 0 || compare({ rowIndex, cellIndex }, end) > 0) return;
        const from = rowIndex === start.rowIndex && cellIndex === start.cellIndex ? start.sourceOffset : 0, to = rowIndex === end.rowIndex && cellIndex === end.cellIndex ? end.sourceOffset : cell.content.length;
        cells.push({ cell, path: row.path, fileIndex: row.fileIndex, from, to });
      });
    }
    if (!cells.length || cells.map(({ cell, from, to }) => cell.content.slice(from, to)).join("\n") !== text) throw new Error("Diff 选区文本契约已变化。");
    if (new Set(cells.map((c) => c.fileIndex)).size !== 1 || new Set(cells.map((c) => c.path)).size !== 1) throw new Error("暂不支持跨文件 Diff 选区。");
    if (new Set(cells.map((c) => c.cell.sourceIdentity?.side)).size !== 1) throw new Error("暂不支持同时包含 Diff 两侧的选区。");
    const first = cells[0], last = cells[cells.length - 1], file = model.files[first.fileIndex];
    if (!file || file.path !== first.path) throw new Error("Diff 文件身份不明确。");
    const side = z.enum(["old", "new"]).parse(first.cell.sourceIdentity?.side);
    cells.forEach(({ cell, path }, i) => {
      const identity = cell.sourceIdentity, target = cell.reviewTarget;
      if (cell.type === "header" || !identity || !target || !Number.isInteger(cell.lineNumber) || cell.lineNumber === null || cell.lineNumber < 1 || target.side !== side || identity.side !== side || target.filePath !== path || target.content !== cell.content || target.hunkIndex !== identity.hunkIndex || target.lineIndex !== identity.lineIndex || target.lineNumber !== cell.lineNumber || (side === "old" ? target.oldLineNumber : target.newLineNumber) !== cell.lineNumber) throw new Error("请选择 Diff 原文代码，区块标题无法添加。");
      if (i && cell.lineNumber !== Number(cells[i - 1].cell.lineNumber) + 1) throw new Error("暂不支持不连续的 Diff 原文行。");
    });
    const props = binding.entry.fiber.memoizedProps, mode = z.object({ kind: z.enum(["commit", "working"]) }).passthrough().parse(field(props, "mode"));
    let revision: Extract<ExternalOrigin, { kind: "diff" }>["revision"];
    if (mode.kind === "commit") {
      if (captured.context.target.kind !== "commit_diff") throw new Error("无法验证 Diff 提交来源。");
      revision = { kind: "commit", sha: nonempty.parse(field(captured.context.target, "sha")) };
    } else {
      const changesIds = resolveModuleIds(source, { changes: ["ChangesSurface", "resolveDiffLayout", "DiffModeMenu"] }), ChangesSurface = callable.parse(field(requireModule(changesIds.changes), "ChangesSurface"));
      const owners = binding.entry.ancestors.filter((fiber) => fiber.type === ChangesSurface); if (owners.length !== 1) throw new Error("无法验证工作区 Diff 比较来源。");
      const owner = owners[0], ownerProps = z.object({ serverId: nonempty, workspaceId: nonempty, cwd: nonempty }).parse(owner.memoizedProps);
      if (ownerProps.serverId !== captured.workspace.serverId || ownerProps.cwd !== captured.workspace.root || scope({ ...captured.context, workspaceId: ownerProps.workspaceId }).workspaceId !== captured.workspace.workspaceId) throw new Error("工作区 Diff 来源已变化。");
      const data = field(field(owner.updateQueue, "memoCache"), "data"); if (!Array.isArray(data)) throw new Error("工作区 Diff 比较接口已变化。");
      const matches = data.flatMap((row) => {
        if (!Array.isArray(row)) return [];
        return row.flatMap((value) => {
          if (field(value, "files") !== field(props, "files") || field(value, "reviewActions") !== field(mode, "reviewActions") || !["base", "uncommitted"].includes(String(field(value, "diffMode"))) || !["status", "baseRef", "isDiffLoading", "diffPayloadError"].every((key) => value && typeof value === "object" && Object.hasOwn(value, key))) return [];
          return row.flatMap((options) => field(options, "serverId") === captured.workspace.serverId && field(options, "cwd") === captured.workspace.root && field(options, "mode") === field(value, "diffMode") && field(options, "baseRef") === field(value, "baseRef") && typeof field(options, "ignoreWhitespace") === "boolean" && options && typeof options === "object" && Object.hasOwn(options, "enabled") ? [{ value, options }] : []);
        });
      });
      if (matches.length !== 1) throw new Error("工作区 Diff 比较来源不明确。");
      const comparison = z.enum(["base", "uncommitted"]).parse(field(matches[0].value, "diffMode"));
      revision = { kind: "working", mode: comparison, baseRef: comparison === "base" ? nonempty.parse(field(matches[0].value, "baseRef")).trim() : null, ignoreWhitespace: z.boolean().parse(field(matches[0].options, "ignoreWhitespace")), revisionResolution: "unresolved" };
    }
    if (field(binding.modelRef, "current") !== model || field(binding.selectionRef, "current") !== binding.selection) throw new Error("Diff 选区已变化。");
    const lineStart = z.number().int().positive().parse(first.cell.lineNumber), lineEnd = last.to === 0 && cells.length > 1 ? Number(cells[cells.length - 2].cell.lineNumber) : z.number().int().positive().parse(last.cell.lineNumber);
    const canonicalHunks = z.array(z.object({ oldStart: z.number(), oldCount: z.number(), newStart: z.number(), newCount: z.number(), lines: z.array(z.object({ type: z.string(), content: z.string() })) })).parse(file.file.hunks);
    const sourceFile = fileIdentity(side === "old" ? file.file.oldPath ?? file.path : file.path, captured.workspace), canonical = JSON.stringify({ path: file.path, oldPath: file.file.oldPath ?? null, isNew: file.file.isNew, isDeleted: file.file.isDeleted, hunks: canonicalHunks });
    const snapshot = fingerprint(canonical).then((version): ExternalSnapshot => ({ text, title: `${file.path}:${lineStart}-${lineEnd} · ${side === "old" ? "旧" : "新"}侧`, origin: { kind: "diff", workspace: captured.workspace, tabId: captured.context.tabId, segment: { file: sourceFile, displayPath: file.path, oldPath: file.file.oldPath ?? null, side, lineStart, lineEnd, startColumn: first.from, endColumn: last.to, cells: cells.map(({ cell, from, to }) => ({ lineNumber: Number(cell.lineNumber), hunkIndex: Number(cell.sourceIdentity?.hunkIndex), lineIndex: Number(cell.sourceIdentity?.lineIndex), type: cell.type, from, to })) }, revision, version } }));
    const contextValid = sourceGuard(root, captured);
    const valid = () => { try { const current = diffBinding(root); return visible(root) && current.model === model && sameTarget(current.captured, captured); } catch { return false; } };
    return makeOffer(root, captured, [model, canonical, JSON.stringify(ordered), JSON.stringify(revision)], snapshot, valid, () => {
      if (!contextValid() || field(binding.modelRef, "current") !== model) return { kind: "unavailable" };
      const box = root.getBoundingClientRect(), bounds = { left: Math.max(0, box.left), right: Math.min(innerWidth, box.right), top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom) };
      const rectangles = z.array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), fileIndex: z.number().int(), clipX: z.number(), clipWidth: z.number() })).parse(helpers.selectionRectangles({ model, selection }));
      const rects = rectangles.flatMap((rect) => {
        const offset = Number(binding.offsets.get(model.files[rect.fileIndex]?.path) ?? 0), left = Math.max(bounds.left, box.left + rect.clipX, box.left + rect.x - offset), right = Math.min(bounds.right, box.left + rect.clipX + rect.clipWidth, box.left + rect.x - offset + rect.width), top = Math.max(bounds.top, box.top + rect.y - binding.scroll.scrollTop), bottom = Math.min(bounds.bottom, box.top + rect.y - binding.scroll.scrollTop + rect.height);
        return right > left && bottom > top ? [new DOMRect(left, top, right - left, bottom - top)] : [];
      });
      return rects.length ? { kind: "visible", rects, bounds } : { kind: "offscreen" };
    }, async () => reveal(await snapshot));
  };

  const reveal: SourceHost["reveal"] = async (snapshot) => {
    const { origin } = snapshot;
    if (!scopeValid(origin.workspace)) return { kind: "unavailable", reason: "请返回原工作区后定位原文。" };
    if (origin.kind === "terminal") return { kind: "unavailable", reason: "终端会话或缓冲区已变化，原文位置不可用。" };
    if (origin.kind === "file") {
      for (const root of document.querySelectorAll<HTMLElement>('[data-testid="workspace-file-pane"]')) {
        try {
          const current = contextFor(root);
          if (!visible(root) || current.context.target.kind !== "file" || !sameTarget(current.workspace, origin.workspace) || field(current.context.target, "path") !== origin.file.requestedPath) continue;
          const cm = root.querySelector(".cm-content"); if (!cm) continue;
          const id = capability("editor"), EditorView = field(requireModule(id.editor), "EditorView"), find = callable.parse(field(EditorView, "findFromDOM")), view = find.call(EditorView, cm), doc = field(field(view, "state"), "doc");
          const content = z.string().parse(callable.parse(field(doc, "toString")).call(doc));
          if ((await fingerprint(content)).digest !== origin.version.digest || !scopeValid(origin.workspace) || field(field(view, "state"), "doc") !== doc || !visible(root) || !root.contains(z.instanceof(HTMLElement).parse(field(view, "dom")))) continue;
          if (field(contextFor(root).context.target, "path") !== origin.file.requestedPath) continue;
          if (z.string().parse(callable.parse(field(doc, "sliceString")).call(doc, origin.from, origin.to)) !== snapshot.text) continue;
          callable.parse(field(view, "dispatch")).call(view, { selection: { anchor: origin.from, head: origin.to }, scrollIntoView: true });
          return { kind: "highlighted" };
        } catch { continue; }
      }
    }
    if (!scopeValid(origin.workspace)) return { kind: "unavailable", reason: "工作区已切换。" };
    const target = origin.kind === "diff" ? origin.revision.kind === "commit" ? { kind: "commit_diff", sha: origin.revision.sha } : { kind: "working_diff", focusPath: origin.segment.displayPath, focusRequestId: Date.now() }
      : pathFunctions().createWorkspaceFileTabTarget(pathFunctions().normalizeWorkspaceFileLocation({ path: origin.file.requestedPath }));
    if (!target) return { kind: "unavailable", reason: "原文路径无法验证。" };
    const opened = functions(requireModule(capability("opener").opener), ["openWorkspaceTargetAtLocation"]).openWorkspaceTargetAtLocation({ workspaceKey: origin.workspace.workspaceKey, target, location: "main" });
    return typeof opened === "string" && opened.length ? { kind: "opened", reason: origin.kind === "diff" ? "已打开 Diff，原文行位置不可用。" : "已打开文件，原文位置未验证。" } : { kind: "unavailable", reason: "无法打开原文标签。" };
  };
  const rootFor = (target?: EventTarget | null): HTMLElement | null => {
    const element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
    return element?.closest<HTMLElement>('[data-testid="terminal-surface"][data-terminal-scrollbar-root="true"],[data-testid="git-diff-canvas-root"],[data-testid="workspace-file-pane"]') ?? null;
  };
  const capture: SourceHost["capture"] = (target) => {
    if (disposed) return null;
    reconcileRoute();
    if (currentHostId(window.location.href) !== installationOwner.hostId) return null;
    const selection = window.getSelection(), root = rootFor(target) ?? rootFor(selection?.anchorNode);
    if (!root || !visible(root)) return null;
    try {
      if (root.matches('[data-testid="terminal-surface"]')) return captureTerminal(root);
      if (root.matches('[data-testid="git-diff-canvas-root"]')) return captureDiff(root);
      return captureFile(root);
    } catch (error) { return { kind: "unavailable", root, reason: reason(error) }; }
  };
  const cleanups = new Set<() => void>();
  return {
    capture, reveal,
    observe(listener) {
      let frame = 0, scanFrame = 0, activeRoot: HTMLElement | null = null, stopped = false;
      let lastSelection: ExternalSelection = null, refreshPending = false;
      const terminals = new Map<HTMLElement, { terminal: Terminal; dispose(): void }>();
      const publish = (target?: EventTarget | null, refresh = true) => {
        if (stopped || disposed) return;
        if (target) activeRoot = rootFor(target);
        refreshPending ||= refresh;
        cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
          frame = 0; if (stopped) return;
          if (refreshPending) lastSelection = capture(activeRoot);
          refreshPending = false; listener(lastSelection);
        });
      };
      const scan = () => {
        scanFrame = 0; reconcileRoute();
        for (const [root, bound] of terminals) {
          let current: Terminal | null = null; try { if (visible(root)) current = terminalBinding(root).terminal; } catch {}
          if (current !== bound.terminal) { bound.dispose(); terminalEpochs.get(bound.terminal)?.dispose(); terminalEpochs.delete(bound.terminal); terminals.delete(root); }
        }
        for (const root of document.querySelectorAll<HTMLElement>('[data-testid="terminal-surface"][data-terminal-scrollbar-root="true"]')) {
          if (terminals.has(root) || !visible(root)) continue;
          try {
            const { terminal } = terminalBinding(root), onChange = terminal.onSelectionChange(() => publish(root)), onScroll = terminal.onScroll(() => { if (activeRoot === root) publish(root, false); });
            const resize = new ResizeObserver(() => { if (activeRoot === root) publish(root, false); }); resize.observe(root);
            terminals.set(root, { terminal, dispose: () => { onChange.dispose(); onScroll.dispose(); resize.disconnect(); } });
          } catch {}
        }
        if (activeRoot && (!visible(activeRoot) || lastSelection?.kind === "offer" && !lastSelection.offer.validForAdd())) { activeRoot = null; lastSelection = null; listener(null); }
      };
      const scheduleScan = () => { if (!scanFrame && !stopped) scanFrame = requestAnimationFrame(scan); };
      const ignored = (target: EventTarget | null) => target instanceof Element && !!target.closest('[data-paseo-quote],[data-paseo-quote-editor],[data-paseo-quote-preview],[data-paseo-quote-source]');
      const pointer = (event: Event) => { if (!ignored(event.target)) publish(event.target); };
      const selection = () => { if (!ignored(document.activeElement) && rootFor(window.getSelection()?.anchorNode)) publish(window.getSelection()?.anchorNode); };
      const viewport = () => { scheduleScan(); if (activeRoot) publish(activeRoot, false); };
      const observer = new MutationObserver((records) => { if (records.some((entry) => { const target = entry.target instanceof Element ? entry.target : entry.target.parentElement; return target && !target.closest("[data-paseo-quote],[data-paseo-quote-chip],[data-paseo-quote-source],[data-paseo-quote-editor],[data-paseo-quote-preview]"); })) scheduleScan(); }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "aria-hidden"] });
      const unlayout = callable.parse(layoutStore.subscribe(scheduleScan)), unsession = callable.parse(sessions.subscribe(scheduleScan));
      document.addEventListener("pointerup", pointer, true); document.addEventListener("keyup", pointer, true); document.addEventListener("selectionchange", selection);
      window.addEventListener("resize", viewport); window.addEventListener("scroll", viewport, true); scheduleScan();
      const cleanup = () => {
        if (stopped) return; stopped = true; cancelAnimationFrame(frame); cancelAnimationFrame(scanFrame); observer.disconnect();
        for (const bound of terminals.values()) bound.dispose(); terminals.clear(); unlayout(); unsession();
        document.removeEventListener("pointerup", pointer, true); document.removeEventListener("keyup", pointer, true); document.removeEventListener("selectionchange", selection);
        window.removeEventListener("resize", viewport); window.removeEventListener("scroll", viewport, true); cleanups.delete(cleanup);
      };
      cleanups.add(cleanup); return cleanup;
    },
    dispose() { disposed = true; unlayoutContext(); unsessionContext(); window.removeEventListener("popstate", reconcileRoute); window.removeEventListener("hashchange", reconcileRoute); focusHistory.clear(); for (const cleanup of cleanups) cleanup(); for (const tracker of terminalEpochs.values()) tracker.dispose(); terminalEpochs.clear(); },
  };
}

export class ModuleSignatureMismatch extends Error {}

export function resolveSemanticModuleIds(source: string, signatures: Record<string, readonly string[]>): Record<string, number> {
  const chunks = source.split(/(?=__d\(function\()/), ids: Record<string, number> = {};
  for (const [name, tokens] of Object.entries(signatures)) {
    const matching = chunks.flatMap((chunk) => {
      if (!chunk.startsWith("__d(function(") || !tokens.every((token) => chunk.includes(token))) return [];
      const match = chunk.match(/\},(\d+),\[[\d,]*\]\);/); return match ? [Number(match[1])] : [];
    });
    if (matching.length !== 1) throw new ModuleSignatureMismatch(`当前 Paseo 的 ${name} 选择接口无法验证。`);
    ids[name] = matching[0];
  }
  return ids;
}

export async function discoverSourceHost({ owner, signal }: { owner: InstallationOwner; signal: AbortSignal }): Promise<SourceHost> {
  const runtime = z.object({ __r: callable }).parse(globalThis), base = new URL(window.location.href);
  const urls = Array.from(document.scripts).flatMap((script) => { if (!script.src) return []; const url = new URL(script.src, base); return url.origin === base.origin && url.protocol === base.protocol ? [url.href] : []; });
  for (const url of urls) {
    const response = await fetch(url, { signal }); if (!response.ok) continue;
    const source = await response.text(); if (signal.aborted) throw new Error("注释插件已关闭。");
    if (!source.includes("useWorkspaceLayoutStore")) continue;
    return createSourceHost((id) => runtime.__r(id), source, owner);
  }
  throw new Error("未找到工作区原文选择接口。");
}
