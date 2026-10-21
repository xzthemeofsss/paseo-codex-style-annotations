import assert from "node:assert/strict";
import { test } from "node:test";
import { compileFunction } from "node:vm";
import { createContext, memo } from "react";
import { z } from "zod";
import { resolveModuleIds } from "../client/host-draft-bridge";
import { discoverSentNative, inspectSentNative, SENT_MODULES } from "../client/sent-native";
import { bundle, bundlePath } from "./native-host";
import { JSDOM } from "jsdom";

const factory = z.custom<(global: unknown, require: (id: number) => unknown, imports: unknown, importsAll: unknown, module: { exports: unknown }, exports: Record<string, unknown>, dependencies: number[]) => void>((value) => typeof value === "function");
function nativeExports(id: number) {
  const source = bundle.split(/(?=__d\(function\()/).find((chunk) => chunk.startsWith("__d(function(") && new RegExp(`\\},${id},\\[[\\d,]*\\]\\);`).test(chunk));
  assert.ok(source);
  const end = source.match(/\},\d+,\[[\d,]*\]\);/); assert.ok(end && end.index !== undefined);
  const exports: Record<string, unknown> = {};
  const stub: unknown = new Proxy(() => stub, { get(_target, key) {
    if (key === "memo") return memo;
    if (key === "createContext") return createContext;
    if (key === "__esModule") return true;
    return stub;
  } });
  compileFunction(source.slice(0, end.index + end[0].length), ["__d"])((run: unknown, _id: unknown, dependencies: unknown) => {
    factory.parse(run)(globalThis, () => stub, undefined, undefined, { exports }, exports, z.array(z.number()).parse(dependencies));
  });
  return exports;
}

test("installed Paseo bundle resolves and validates original native UserMessage/Frame/Label references", () => {
  const ids = resolveModuleIds(bundle, SENT_MODULES);
  const message = nativeExports(ids.message), attachment = nativeExports(ids.attachment);
  const native = inspectSentNative(message, attachment);
  assert.equal(native.user, message.UserMessage); assert.equal(native.frame, attachment.AttachmentFrame); assert.equal(native.label, attachment.AttachmentLabel);
  assert.throws(() => resolveModuleIds(bundle + bundle, SENT_MODULES), /unclear/);
  assert.throws(() => inspectSentNative({ ...message, UserMessage: memo(() => null) }, attachment), /changed/);
  assert.throws(() => inspectSentNative(message, { ...attachment, AttachmentLabel: () => null }), /changed/);
  assert.match(bundlePath, /index-.*\.js$/);
});

test("running same-origin scripts discover the original native references and honor abort", async () => {
  const ids = resolveModuleIds(bundle, SENT_MODULES);
  const message = nativeExports(ids.message), attachment = nativeExports(ids.attachment);
  const dom = new JSDOM('<script src="https://other.test/ignored.js"></script><script src="/current-app.js"></script>', { url: "https://paseo.test/" });
  const prior = { window: Reflect.get(globalThis, "window"), document: Reflect.get(globalThis, "document"), fetch: globalThis.fetch, require: Reflect.get(globalThis, "__r") };
  const requests: string[] = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    __r: (id: number) => id === ids.message ? message : id === ids.attachment ? attachment : undefined,
    fetch: async (url: string) => { requests.push(url); return { ok: true, text: async () => bundle }; },
  });
  try {
    const native = await discoverSentNative(new AbortController().signal);
    assert.equal(native.user, message.UserMessage); assert.equal(native.frame, attachment.AttachmentFrame);
    assert.deepEqual(requests, ["https://paseo.test/current-app.js"]);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(discoverSentNative(abort.signal), /closed/);
  } finally {
    Object.assign(globalThis, { window: prior.window, document: prior.document, fetch: prior.fetch, __r: prior.require }); dom.window.close();
  }
});
