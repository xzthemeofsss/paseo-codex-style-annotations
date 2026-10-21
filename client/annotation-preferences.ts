import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { text, type LocaleSource } from "./messages";
import { annotationValuesSchema, preferences, type AnnotationKind, type AnnotationValues } from "../shared/preferences";

export type PreferenceState = { status: "loading" } | { status: "ready"; values: AnnotationValues } | { status: "error"; error: string };
export interface AnnotationPreferences {
  state(): PreferenceState;
  refresh(): Promise<void>;
  accept(values: AnnotationValues): void;
  enabled(kind: AnnotationKind): boolean;
  check(kind: AnnotationKind, language?: LocaleSource): Promise<{ allowed: true } | { allowed: false; reason: string }>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
const resultSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("ready"), values: annotationValuesSchema, revision: z.string() }), z.object({ status: z.literal("invalid"), error: z.string(), revision: z.string() })]);
export function createAnnotationPreferences(client: Pick<PluginClientContext, "rpc">): AnnotationPreferences {
  let state: PreferenceState = { status: "loading" }, pending: Promise<void> | null = null, generation = 0, disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: PreferenceState) => { if (!disposed) { state = next; for (const listener of listeners) listener(); } };
  const refresh = () => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const revision = generation;
    pending = (async () => {
      try {
        const result = resultSchema.parse(await client.rpc(settingsRpc(preferences.id).read, {}));
        if (revision !== generation) return;
        publish(result.status === "ready" ? { status: "ready", values: result.values } : { status: "error", error: result.error });
      } catch (cause) { if (revision === generation) publish({ status: "error", error: cause instanceof Error ? cause.message : String(cause) }); }
    })().finally(() => { pending = null; });
    return pending;
  };
  const enabled = (kind: AnnotationKind) => !disposed && state.status === "ready" && state.values[kind];
  const controller: AnnotationPreferences = {
    state: () => state, refresh, enabled,
    accept(values) { generation++; publish({ status: "ready", values: annotationValuesSchema.parse(values) }); },
    async check(kind, language) {
      const t = text(language);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = generation; await refresh();
        if (before !== generation) continue;
        return enabled(kind) ? { allowed: true } : { allowed: false, reason: state.status === "error" ? t.prefsLoadFailed(state.error) : state.status === "loading" ? t.prefsLoading : t.prefsDisabled(t.kinds[kind]) };
      }
      return { allowed: false, reason: t.prefsChanging };
    },
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { disposed = true; generation++; listeners.clear(); },
  };
  void refresh(); return controller;
}
