import { readFileSync, readdirSync } from "node:fs";
import { compileFunction } from "node:vm";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createDraftHost, MODULE_SIGNATURES, resolveModuleIds } from "../client/host-draft-bridge";

const bundleDirectory = "/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web";
function installedBundle(): string {
  const files = readdirSync(bundleDirectory).filter((name) => /^index-.*\.js$/.test(name));
  if (files.length !== 1) throw new Error("Set PASEO_BUNDLE to the intended Paseo web bundle");
  return `${bundleDirectory}/${files[0]}`;
}
export const bundlePath = process.env.PASEO_BUNDLE ?? installedBundle();
export const bundle = readFileSync(bundlePath, "utf8");
const factorySchema = z.custom<(global: unknown, require: (id: number) => unknown, imports: unknown, importsAll: unknown, module: { exports: unknown }, exports: Record<string, unknown>, dependencies: number[]) => void>((value) => typeof value === "function");
const callable = z.custom<(...args: unknown[]) => unknown>((value) => typeof value === "function");
const registered = new Map<number, { factory: z.infer<typeof factorySchema>; dependencies: number[] }>();
for (const chunk of bundle.split(/(?=__d\(function\()/)) {
  if (!chunk.startsWith("__d(function(")) continue;
  const end = chunk.match(/\},\d+,\[[\d,]*\]\);/);
  if (!end || end.index === undefined) continue;
  compileFunction(chunk.slice(0, end.index + end[0].length), ["__d"])(
    (factory: unknown, id: unknown, dependencies: unknown) => {
      registered.set(z.number().parse(id), { factory: factorySchema.parse(factory), dependencies: z.array(z.number()).parse(dependencies) });
    },
  );
}
const ids = resolveModuleIds(bundle, MODULE_SIGNATURES);
const extras = resolveModuleIds(bundle, {
  migration: ["PersistedDraftStoreSchema", "migratePersistedState"],
  persistence: ["createDraftPersistStorage", "DRAFT_PERSIST_INTERVAL_MS"],
  validatedStorage: ["createValidatedPersistStorage"],
  publication: ["AfterPaintPublication", "browserAfterPaintScheduler"],
  focus: ["resolveKeyboardFocusScope"],
});
const itemIds = resolveModuleIds(bundle.split(/(?=__d\(function\()/).filter((chunk) => /\.defineAttachmentSource=function/.test(chunk)).join(""), { items: ["PluginAttachmentItemSchema", "PluginAttachmentSearchPayloadSchema"] });

export async function nativeHost(seed: ReadonlyMap<string, string> = new Map()) {
  const cache = new Map<number, unknown>();
  const overrides = new Map<number, unknown>();
  const definition = (id: number) => {
    const value = registered.get(id);
    if (!value) throw new Error(`Missing native module ${id}`);
    return value;
  };
  const dependency = (id: number, index: number) => {
    const value = definition(id).dependencies[index];
    if (value === undefined) throw new Error("Missing native dependency");
    return value;
  };
  const load = (id: number): unknown => {
    if (overrides.has(id)) return overrides.get(id);
    if (cache.has(id)) return cache.get(id);
    const module = { exports: {} };
    const value = definition(id);
    cache.set(id, module.exports);
    value.factory(globalThis, load, undefined, undefined, module, module.exports, value.dependencies);
    return module.exports;
  };
  const sessions = {
    "fixture-host": { agents: new Map([["agent-one", {}], ["agent-two", {}]]), agentDetails: new Map(), queuedMessages: new Map(), agentStreamTail: new Map(), agentStreamHead: new Map() },
  };
  const sessionStore = Object.assign(() => undefined, { getState: () => ({ sessions }) });
  const storage = new Map(seed);
  const adapter = {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { storage.set(key, value); },
    removeItem: async (key: string) => { storage.delete(key); },
  };
  overrides.set(dependency(ids.attachment, 0), { z });
  overrides.set(dependency(itemIds.items, 0), { z });
  overrides.set(dependency(ids.attachment, 1), load(itemIds.items));
  overrides.set(dependency(ids.draft, 1), load(ids.attachment));
  overrides.set(dependency(ids.draft, 2), { z });
  overrides.set(dependency(ids.keys, 0), { generateMessageId: () => "fixture-message" });
  overrides.set(dependency(extras.migration, 0), load(ids.keys));
  overrides.set(dependency(extras.migration, 1), { z });
  overrides.set(dependency(extras.migration, 2), load(ids.draft));
  overrides.set(dependency(extras.validatedStorage, 0), { z });
  overrides.set(dependency(ids.store, 0), { create });
  overrides.set(dependency(ids.store, 1), { persist });
  overrides.set(dependency(ids.store, 2), { __esModule: true, default: adapter });
  overrides.set(dependency(ids.store, 3), {});
  overrides.set(dependency(ids.store, 4), { garbageCollectAttachments: async () => {} });
  overrides.set(dependency(ids.store, 5), { collectRetainedAttachmentIds: () => [] });
  overrides.set(dependency(ids.store, 6), { useCreateFlowStore: { getState: () => ({ pendingByDraftId: {} }) } });
  overrides.set(dependency(ids.store, 7), { useSessionStore: sessionStore });
  overrides.set(dependency(ids.store, 8), { useWorkspaceAttachmentsStore: { getState: () => ({ attachmentsByScope: {} }) } });
  overrides.set(dependency(ids.store, 9), load(ids.draft));
  overrides.set(dependency(ids.store, 10), load(extras.migration));
  overrides.set(dependency(ids.store, 11), load(extras.persistence));
  overrides.set(dependency(ids.store, 12), load(extras.validatedStorage));
  overrides.set(ids.sessions, { useSessionStore: sessionStore });
  const host = createDraftHost(load, ids);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const store = z.object({ useDraftStore: z.custom<{ getState(): unknown; subscribe(listener: (...args: unknown[]) => void): () => void }>((value) => typeof value === "function") }).parse(load(ids.store)).useDraftStore;
  const getState = () => z.object({ editDraftText: callable, clearDraftInput: callable, drafts: z.record(z.string(), z.unknown()) }).parse(store.getState());
  const converter = z.object({ pluginResourceAttachmentToAgentAttachment: callable }).parse(load(ids.attachment)).pluginResourceAttachmentToAgentAttachment;
  const Publication = z.object({ AfterPaintPublication: z.custom<new(publish: (text: string) => void, scheduler: { schedule(callback: () => void): () => void }) => { stage(text: string): void; flush(): void }>((value) => typeof value === "function") }).parse(load(extras.publication)).AfterPaintPublication;
  const resolveKeyboardFocusScope = z.object({ resolveKeyboardFocusScope: callable }).parse(load(extras.focus)).resolveKeyboardFocusScope;
  return { host, ids, storage, converter, Publication, store, getState, resolveKeyboardFocusScope };
}

export function nativePluginCapabilities(paseo: object) {
  const id = resolveModuleIds(bundle, { capabilities: ["createPluginCapabilities", "createPluginAgentActionContext"] }).capabilities;
  const definition = registered.get(id);
  if (!definition) throw new Error("Missing installed plugin capabilities module");
  const module = { exports: {} };
  definition.factory(globalThis, () => ({}), undefined, undefined, module, module.exports, definition.dependencies);
  const capabilities = z.object({ createPluginCapabilities: callable }).parse(module.exports);
  return z.object({ paseo: z.unknown() }).parse(capabilities.createPluginCapabilities({ paseo }, {}));
}
