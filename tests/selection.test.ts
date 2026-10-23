import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";
import { z } from "zod";
import { installQuoteComposer } from "../client/quote-composer";
import * as draftBridge from "../client/host-draft-bridge";
import { readQuotes, type DraftHost, type InstallationOwner } from "../client/host-draft-bridge";
import { nativeHost } from "./native-host";
import { fixtureOwner, setup, settle } from "./dom";
import type { AnnotationPreferences } from "../client/annotation-preferences";

const bundled = build({ entryPoints: [new URL("../client/web.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs", external: ["react-native", "./quote-composer", "./host-draft-bridge"] });
async function selectionBar(host: DraftHost, discoverOwner: (input: { signal: AbortSignal }) => Promise<InstallationOwner> = async () => fixtureOwner) {
  const result = await bundled;
  const module = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  compileFunction(result.outputFiles[0].text, ["require", "module", "exports"])((name: string) => {
    if (name === "react-native") return { Platform: { OS: "web" } };
    if (name === "./quote-composer") return { installQuoteComposer: (options: Parameters<typeof installQuoteComposer>[0]) => installQuoteComposer({ ...options, discover: async () => host }) };
    if (name === "./host-draft-bridge") return { ...draftBridge, discoverInstallationOwner: discoverOwner };
    return nativeRequire(name);
  }, module, module.exports);
  return z.object({ installSelectionBar: z.custom<(client: { paseo: unknown; openPanel: (...args: unknown[]) => void }, preferences?: AnnotationPreferences) => () => void>((value) => typeof value === "function") }).parse(module.exports).installSelectionBar;
}

test("two installed toolbars follow their host route and preferences without reinstalling", async () => {
  const { host } = await nativeHost();
  const { dom, anchor } = setup();
  const secondOwner = draftBridge.installationOwnerSchema.parse({ hostId: "second-host" });
  const values = { chat: false, file: true, diff: true, markdown: true, terminal: true };
  const disabled: AnnotationPreferences = { state: () => ({ status: "ready", values }), refresh: async () => {}, accept() {}, enabled: (kind) => values[kind], check: async () => ({ allowed: false, reason: "disabled" }), subscribe: () => () => {}, dispose() {} };
  const first = (await selectionBar(host))({ paseo: {}, openPanel() {} });
  const second = (await selectionBar(host, async () => secondOwner))({ paseo: {}, openPanel() {} }, disabled);
  try {
    await settle();
    const rect = new dom.window.DOMRect(100, 100, 100, 20);
    dom.window.Range.prototype.getClientRects = () => Object.assign([rect], { item: () => rect });
    dom.window.Range.prototype.getBoundingClientRect = () => rect;
    const range = dom.window.document.createRange(); range.selectNodeContents(anchor); dom.window.getSelection()?.addRange(range);
    const visible = () => [...dom.window.document.querySelectorAll<HTMLElement>("[data-paseo-quote]")].filter((element) => element.style.display !== "none");
    anchor.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true })); await settle();
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].shadowRoot?.querySelector<HTMLButtonElement>('[data-action="quote"]')?.disabled, false);
    dom.window.history.replaceState({}, "", "/h/second-host/workspace/workspace-one");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    anchor.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true })); await settle();
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].shadowRoot?.querySelector<HTMLButtonElement>('[data-action="quote"]')?.disabled, true);
    first(); await settle(); assert.equal(visible().length, 1);
  } finally { second(); first(); await host.flush(); dom.window.close(); }
});

test("unload before installation discovery resolves cannot install DOM effects", async () => {
  const { host } = await nativeHost();
  const { dom } = setup();
  let resolveOwner: ((owner: InstallationOwner) => void) | undefined;
  let startup: AbortSignal | undefined;
  const install = await selectionBar(host, ({ signal }) => { startup = signal; return new Promise((resolve) => { resolveOwner = resolve; }); });
  const cleanup = install({ paseo: {}, openPanel() {} });
  cleanup(); assert.equal(startup?.aborted, true);
  resolveOwner?.(fixtureOwner); await settle();
  assert.equal(dom.window.document.querySelector("[data-paseo-quote],[data-paseo-quote-chip],[data-paseo-sent-quotes]"), null);
  await host.flush(); dom.window.close();
});

test("两文字入口立即添加、紧凑可选评论、连续输入，Enter/Esc/IME 不发送 Agent", async () => {
  const { host, resolveKeyboardFocusScope } = await nativeHost();
  const { dom, input, anchor, binding } = setup();
  const install = await selectionBar(host);
  let sent = 0;
  const cleanup = install({ paseo: { agents: { ref: () => ({ send: () => { sent += 1; } }) } }, openPanel: () => {} });
  await settle();
  const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20, x: 100, y: 100, toJSON: () => ({}) };
  dom.window.Range.prototype.getClientRects = () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  dom.window.Range.prototype.getBoundingClientRect = () => rect;
  const range = dom.window.document.createRange();
  range.selectNodeContents(anchor);
  dom.window.getSelection()?.addRange(range);
  anchor.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  await settle();
  const toolbar = dom.window.document.querySelector("[data-paseo-quote]");
  const shadow = toolbar?.shadowRoot;
  assert.deepEqual(Array.from(shadow?.querySelectorAll(".bar button") ?? []).map((button) => button.textContent), ["Add to chat", "Ask in side chat"]);
  assert.equal(shadow?.querySelector('[data-action="reply"],[data-action="send"],[data-action="copy"]'), null);
  const quote = shadow?.querySelector('[data-action="quote"]');
  if (!(quote instanceof dom.window.HTMLButtonElement)) throw new Error("Missing add action");
  quote.click();
  quote.click();
  const popup = dom.window.document.querySelector("[data-paseo-quote-editor]");
  const field = popup?.querySelector("textarea");
  if (!(field instanceof dom.window.HTMLTextAreaElement)) throw new Error("Missing optional comment field");
  assert.equal(field.placeholder, "添加可选评论...");
  assert.equal(field.rows, 1);
  assert.equal(popup?.getAttribute("style")?.includes("width: 294px"), true);
  assert.equal(dom.window.document.activeElement, field);
  field.value = "添加完成前输入";
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  const key = host.key(binding.hostId, binding.agentId);
  assert.equal(readQuotes(host.read(key)).length, 1);
  assert.equal(readQuotes(host.read(key))[0].item.subtitle, "添加完成前输入");
  assert.equal(dom.window.document.activeElement, field);
  const nativeScopes: unknown[] = [];
  dom.window.addEventListener("keydown", (event) => nativeScopes.push(resolveKeyboardFocusScope({ target: event.target, commandCenterOpen: false })), true);
  const keydown = (key: string, options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...options });
    field.dispatchEvent(event);
    return event;
  };
  field.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
  assert.equal(keydown("Enter", { isComposing: true }).defaultPrevented, false);
  assert.equal(keydown("Escape", { keyCode: 229 }).defaultPrevented, false);
  assert.equal(popup?.isConnected, true);
  field.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
  assert.equal(keydown("Enter", { shiftKey: true }).defaultPrevented, false);
  for (const text of ["最新", "最新连续输入", "最新连续输入\n最后一个字"]) {
    field.value = text;
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  assert.equal(readQuotes(host.read(key))[0].item.subtitle, "最新连续输入\n最后一个字");
  assert.equal(keydown("Enter").defaultPrevented, true);
  await settle();
  assert.equal(popup?.isConnected, false);
  assert.equal(input.value, "");
  assert.equal(sent, 0);
  assert.deepEqual(nativeScopes, ["editable", "editable", "editable", "editable"]);
  cleanup();
  await host.flush();
  dom.window.close();
});

test("评论保存失败保留文本并重试同 ID，完成按钮 Escape 的 native capture 为 editable", async () => {
  const { host, resolveKeyboardFocusScope } = await nativeHost();
  const { dom, anchor, binding } = setup();
  let fail = false;
  let failSession = false;
  const controlled: DraftHost = {
    ...host,
    hasAgent(hostId, agentId) { if (failSession) throw new Error("fixture session schema"); return host.hasAgent(hostId, agentId); },
    flush: async () => { if (fail) throw new Error("fixture disk"); await host.flush(); },
  };
  const cleanup = (await selectionBar(controlled))({ paseo: {}, openPanel: () => {} });
  await settle();
  const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20, x: 100, y: 100, toJSON: () => ({}) };
  dom.window.Range.prototype.getClientRects = () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  dom.window.Range.prototype.getBoundingClientRect = () => rect;
  const range = dom.window.document.createRange();
  range.selectNodeContents(anchor);
  dom.window.getSelection()?.addRange(range);
  anchor.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  await settle();
  const toolbar = dom.window.document.querySelector("[data-paseo-quote]");
  const add = toolbar?.shadowRoot?.querySelector('[data-action="quote"]');
  if (!(add instanceof dom.window.HTMLButtonElement)) throw new Error("Missing add action");
  add.click();
  await settle();
  const popup = dom.window.document.querySelector("[data-paseo-quote-editor]");
  const field = popup?.querySelector("textarea");
  if (!(field instanceof dom.window.HTMLTextAreaElement)) throw new Error("Missing comment field");
  const key = host.key(binding.hostId, binding.agentId);
  const id = readQuotes(host.read(key))[0].item.id;
  failSession = true;
  field.value = "会话接口失败的文本";
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  assert.match(popup?.shadowRoot?.querySelector(".status")?.textContent ?? "", /fixture session schema/);
  assert.equal(field.value, "会话接口失败的文本");
  assert.equal(readQuotes(host.read(key))[0].item.subtitle, undefined);
  failSession = false;
  fail = true;
  field.value = "持久保存失败的文本";
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  assert.match(popup?.shadowRoot?.querySelector(".status")?.textContent ?? "", /持久保存未确认/);
  assert.equal(field.value, "持久保存失败的文本");
  assert.equal(readQuotes(host.read(key))[0].item.id, id);
  fail = false;
  const retry = popup?.shadowRoot?.querySelector('[data-action="retry"]');
  if (!(retry instanceof dom.window.HTMLButtonElement)) throw new Error("Missing retry");
  retry.click();
  await settle();
  assert.equal(readQuotes(host.read(key)).length, 1);
  assert.equal(readQuotes(host.read(key))[0].item.id, id);
  const finish = popup?.shadowRoot?.querySelector('[data-action="finish"]');
  if (!(finish instanceof dom.window.HTMLButtonElement)) throw new Error("Missing finish action");
  let nativeScope: unknown;
  dom.window.addEventListener("keydown", (event) => { nativeScope = resolveKeyboardFocusScope({ target: event.target, commandCenterOpen: false }); }, true);
  finish.focus();
  finish.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  assert.equal(nativeScope, "editable");
  await settle();
  assert.equal(readQuotes(host.read(key))[0].item.subtitle, "持久保存失败的文本");
  cleanup();
  await host.flush();
  dom.window.close();
});

test("选区按钮的 Escape 不打断 Agent，失焦和 Escape 完成后保留同一注释", async () => {
  const { host, resolveKeyboardFocusScope } = await nativeHost();
  const { dom, input, anchor, binding } = setup();
  const cleanup = (await selectionBar(host))({ paseo: {}, openPanel: () => {} });
  await settle();
  const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20, x: 100, y: 100, toJSON: () => ({}) };
  dom.window.Range.prototype.getClientRects = () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  dom.window.Range.prototype.getBoundingClientRect = () => rect;
  const show = async () => {
    const range = dom.window.document.createRange();
    range.selectNodeContents(anchor);
    dom.window.getSelection()?.removeAllRanges();
    dom.window.getSelection()?.addRange(range);
    anchor.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
    await settle();
  };
  const nativeScopes: unknown[] = [];
  let interrupts = 0;
  dom.window.addEventListener("keydown", (event) => {
    const scope = resolveKeyboardFocusScope({ target: event.target, commandCenterOpen: false });
    nativeScopes.push(scope);
    if (event.key === "Escape" && (scope === "other" || scope === "message-input")) interrupts += 1;
  }, true);
  for (const action of ["quote", "side"]) {
    await show();
    const popup = dom.window.document.querySelector("[data-paseo-quote]");
    const button = popup?.shadowRoot?.querySelector(`[data-action="${action}"]`);
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error("Missing selection action");
    button.focus();
    button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    assert.equal(popup?.getAttribute("style")?.includes("display: none"), true);
  }
  for (const completion of ["blur", "Escape"]) {
    await show();
    const toolbar = dom.window.document.querySelector("[data-paseo-quote]");
    const add = toolbar?.shadowRoot?.querySelector('[data-action="quote"]');
    if (!(add instanceof dom.window.HTMLButtonElement)) throw new Error("Missing add action");
    add.click();
    await settle();
    const popup = dom.window.document.querySelector("[data-paseo-quote-editor]");
    const field = popup?.querySelector("textarea");
    if (!(field instanceof dom.window.HTMLTextAreaElement)) throw new Error("Missing comment field");
    const key = host.key(binding.hostId, binding.agentId);
    const quote = readQuotes(host.read(key)).at(-1);
    if (!quote) throw new Error("Missing added quote");
    field.value = `完成方式 ${completion}`;
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    if (completion === "blur") input.focus();
    else field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    await settle();
    assert.equal(popup?.isConnected, completion === "blur");
    assert.equal(readQuotes(host.read(key)).find((entry) => entry.item.id === quote.item.id)?.item.subtitle, `完成方式 ${completion}`);
  }
  assert.equal(interrupts, 0);
  assert.deepEqual(nativeScopes, ["editable", "editable", "editable"]);
  assert.equal(input.value, "");
  cleanup();
  await host.flush();
  dom.window.close();
});
