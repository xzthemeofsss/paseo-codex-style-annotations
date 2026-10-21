import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  bindComposer, currentHostId, makeQuote, mutateQuotes, readQuotes, resolveModuleIds, MODULE_SIGNATURES,
  type DraftHost, writeQuoteComment,
} from "../client/host-draft-bridge";
import { installQuoteComposer } from "../client/quote-composer";
import { formatQuote } from "../client/format";
import { bundle, nativeHost } from "./native-host";

import { setup, settle } from "./dom";

function existingEditor(fixture: ReturnType<typeof setup>) {
  fixture.wrapper.querySelector("[data-paseo-quote-chip]")?.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
  fixture.dom.window.document.querySelector("[data-paseo-quote-preview]")?.shadowRoot?.querySelector<HTMLButtonElement>(".edit")?.click();
  const element = fixture.dom.window.document.querySelector<HTMLElement>("[data-paseo-quote-editor]");
  const field = element?.querySelector("textarea");
  if (!element || !field) throw new Error("Missing existing annotation editor");
  const action = (name: string) => {
    const button = element.shadowRoot?.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
    if (!button) throw new Error(`Missing ${name} action`);
    return button;
  };
  return { element, field, action };
}

for (const dismiss of ["cancel", "Escape", "outside"] as const) {
  test(`existing edit keeps input, blur and composition local before ${dismiss} discards`, async () => {
    const { host } = await nativeHost();
    const fixture = setup(), { binding, input, anchor, dom } = fixture;
    const key = host.key(binding.hostId, binding.agentId);
    const plugin = installQuoteComposer({ discover: async () => host });
    try {
      const added = await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
      if (added.kind === "not-written") throw new Error(added.reason);
      await plugin.setComment(added.ref, "saved comment");
      await settle();
      const before = structuredClone(host.read(key));
      const { element, field, action } = existingEditor(fixture);
      field.value = "unsaved edit";
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      field.dispatchEvent(new dom.window.Event("blur"));
      field.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      field.value = "unsaved edit拼音";
      field.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
      await settle();
      assert.deepEqual(host.read(key), before, "staged edits must not write native attachments");
      if (dismiss === "cancel") action("cancel").click();
      else if (dismiss === "outside") input.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, composed: true }));
      else field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: dismiss, bubbles: true, composed: true, cancelable: true }));
      await settle();
      assert.equal(element.isConnected, false);
      assert.deepEqual(host.read(key), before);
    } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
  });
}

for (const save of ["button", "Meta", "Control"] as const) {
  test(`existing edit saves multiline and empty comments through ${save}`, async () => {
    const { host, resolveKeyboardFocusScope } = await nativeHost();
    const fixture = setup(), { binding, input, anchor, dom } = fixture;
    const key = host.key(binding.hostId, binding.agentId);
    const other = { kind: "workspace_file", path: "keep.txt", selection: { kind: "whole_file" } };
    host.save(key, { text: "keep body", attachments: [other] });
    const plugin = installQuoteComposer({ discover: async () => host });
    try {
      await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
      for (const comment of ["first line\n第二行", ""]) {
        const { element, field, action } = existingEditor(fixture);
        field.value = comment;
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true });
        field.dispatchEvent(enter);
        assert.equal(enter.defaultPrevented, false, "plain Enter remains a textarea newline");
        assert.equal(element.isConnected, true);
        assert.equal(resolveKeyboardFocusScope({ target: field, commandCenterOpen: false }), "editable");
        assert.deepEqual(Array.from(element.shadowRoot?.querySelectorAll(".footer button") ?? []).map((button) => button.getAttribute("data-action")), ["delete", "cancel", "save"]);
        assert.equal(field.style.getPropertyValue("min-height"), "36px");
        assert.equal(field.style.getPropertyValue("max-height"), "180px");
        assert.equal(field.style.getPropertyPriority("all"), "important");
        if (save === "button") action("save").click();
        else field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", metaKey: save === "Meta", ctrlKey: save === "Control", bubbles: true, composed: true, cancelable: true }));
        await settle();
        assert.equal(element.isConnected, false);
        const entries = readQuotes(host.read(key));
        assert.equal(entries[0].item.text, comment ? `> original\n\n${comment}` : "> original");
        assert.equal(entries[0].item.subtitle ?? "", comment);
        assert.equal(host.read(key)?.text, "keep body");
        assert.deepEqual(host.read(key)?.attachments[0], other);
      }
    } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
  });
}

test("existing edit delete removes only its ID and preserves body and unrelated attachments", async () => {
  const { host } = await nativeHost();
  const fixture = setup(), { binding, input, anchor, dom } = fixture;
  const key = host.key(binding.hostId, binding.agentId);
  const other = { kind: "workspace_file", path: "keep.txt", selection: { kind: "whole_file" } };
  host.save(key, { text: "keep body", attachments: [other] });
  const plugin = installQuoteComposer({ discover: async () => host });
  try {
    for (let i = 0; i < 2; i++) await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> same text", preview: "same text" });
    const second = readQuotes(host.read(key))[1];
    const { element, field, action } = existingEditor(fixture);
    field.value = "discard this local edit";
    action("delete").click();
    await settle();
    assert.equal(element.isConnected, false);
    assert.deepEqual(host.read(key), { text: "keep body", attachments: [other, second] });
  } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
});

for (const operation of ["save", "delete"] as const) {
  test(`pending existing ${operation} blocks dismissal and uncertain retry preserves its command`, async () => {
    const { host } = await nativeHost();
    const fixture = setup(), { binding, input, anchor, dom } = fixture;
    const key = host.key(binding.hostId, binding.agentId);
    let hold = false, fail = false, flushCount = 0;
    let release: (() => void) | undefined;
    const comments: string[] = [];
    const controlled: DraftHost = { ...host,
      save(draftKey, value) { comments.push(readQuotes(value)[0]?.item.subtitle ?? "absent"); host.save(draftKey, value); },
      async flush() {
        flushCount++;
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        if (fail) throw new Error("disk unavailable");
        await host.flush();
      },
    };
    const plugin = installQuoteComposer({ discover: async () => controlled });
    try {
      await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
      const { element, field, action } = existingEditor(fixture);
      field.value = "submitted command";
      hold = true; fail = true;
      action(operation).click();
      await settle();
      assert.equal(field.disabled, true);
      for (const name of ["save", "cancel", "delete"]) assert.equal(action(name).disabled, true);
      action("cancel").click();
      field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
      input.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, composed: true }));
      await settle();
      assert.equal(element.isConnected, true);
      assert.equal(typeof release, "function");
      hold = false; release?.();
      await settle();
      assert.equal(element.isConnected, true, "uncertainty remains visible even after local deletion");
      assert.match(element.shadowRoot?.querySelector(".status")?.textContent ?? "", /confirm/);
      assert.equal(action("cancel").disabled, false);
      assert.equal(field.disabled, true);
      assert.equal(readQuotes(host.read(key)).length, operation === "delete" ? 0 : 1);
      const beforeRetryFlushes = flushCount;
      field.value = "programmatic replacement must not change retry";
      fail = false;
      action("retry").click();
      await settle();
      assert.equal(element.isConnected, false);
      assert.equal(flushCount, beforeRetryFlushes + 1, "retry confirms persistence even if the quote is already absent");
      assert.equal(readQuotes(host.read(key)).length, operation === "delete" ? 0 : 1);
      if (operation === "save") {
        assert.equal(readQuotes(host.read(key))[0].item.subtitle, "submitted command");
        assert.deepEqual(comments.slice(-2), ["submitted command", "submitted command"]);
      }
    } finally { hold = false; release?.(); plugin.dispose(); await host.flush(); dom.window.close(); }
  });
}

test("a not-written edit save allows correction before a new explicit save", async () => {
  const { host } = await nativeHost();
  const fixture = setup(), { binding, input, anchor, dom } = fixture;
  let reject = false;
  const controlled: DraftHost = { ...host, validateAttachment(value) { if (reject) throw new Error("validation unavailable"); host.validateAttachment(value); } };
  const plugin = installQuoteComposer({ discover: async () => controlled });
  try {
    await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
    const { element, field, action } = existingEditor(fixture);
    field.value = "first attempt"; reject = true; action("save").click();
    await settle();
    assert.equal(element.isConnected, true); assert.equal(field.disabled, false);
    assert.match(element.shadowRoot?.querySelector(".status")?.textContent ?? "", /validation unavailable/);
    assert.equal(readQuotes(host.read(host.key(binding.hostId, binding.agentId)))[0].item.subtitle, undefined);
    field.value = "corrected attempt"; reject = false; action("save").click();
    await settle();
    assert.equal(element.isConnected, false);
    assert.equal(readQuotes(host.read(host.key(binding.hostId, binding.agentId)))[0].item.subtitle, "corrected attempt");
  } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
});

test("existing edit IME ignores actions and confirmation keys until explicit save after composition", async () => {
  const { host } = await nativeHost();
  const fixture = setup(), { binding, input, anchor, dom } = fixture;
  const plugin = installQuoteComposer({ discover: async () => host });
  try {
    await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
    const key = host.key(binding.hostId, binding.agentId), before = structuredClone(host.read(key));
    const { element, field, action } = existingEditor(fixture);
    field.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "拼音";
    for (const name of ["save", "delete", "cancel"]) action(name).click();
    for (const key of ["Enter", "Escape"]) field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, composed: true, cancelable: true }));
    input.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, composed: true }));
    field.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, composed: true, cancelable: true, ...options }));
    await settle();
    assert.equal(element.isConnected, true); assert.deepEqual(host.read(key), before);
    action("save").click(); await settle();
    assert.equal(readQuotes(host.read(key))[0].item.subtitle, "拼音");
  } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
});

for (const operation of ["save", "delete"] as const) {
  for (const change of ["host", "pane", "agent"] as const) {
    test(`pending existing ${operation} completion cannot refocus or reopen after ${change} changes`, async () => {
      const { host } = await nativeHost();
      const fixture = setup(), { binding, input, anchor, dom } = fixture;
      let hold = false;
      let release: (() => void) | undefined;
      const controlled: DraftHost = { ...host, flush: () => hold ? new Promise<void>((resolve) => { release = resolve; }) : host.flush() };
      const plugin = installQuoteComposer({ discover: async () => controlled });
      try {
        await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
        const { element, field, action } = existingEditor(fixture);
        field.value = "submitted before switch"; hold = true; action(operation).click(); await settle();
        if (change === "host") dom.window.history.replaceState({}, "", "/h/other-host/workspace/workspace-one");
        else if (change === "agent") dom.window.document.querySelector('[aria-selected="true"]')?.setAttribute("data-testid", "workspace-tab-agent_agent-two");
        else { const pane = dom.window.document.createElement("div"); pane.setAttribute("data-testid", "workspace-pane-two"); dom.window.document.body.append(pane); pane.append(input); }
        const focus = dom.window.document.createElement("button"); dom.window.document.body.append(focus); focus.focus();
        release?.(); await settle(); await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(element.isConnected, false);
        assert.equal(dom.window.document.activeElement, focus);
        assert.equal(dom.window.document.querySelector("[data-paseo-quote-editor]"), null);
        assert.equal(host.read(host.key("other-host", binding.agentId)), undefined);
      } finally { hold = false; release?.(); plugin.dispose(); await host.flush(); dom.window.close(); }
    });
  }
}

test("当前真实 bundle 按语义唯一定位模块，不依赖 Metro 数字", async () => {
  const ids = resolveModuleIds(bundle, MODULE_SIGNATURES);
  assert.equal(new Set(Object.values(ids)).size, 5);
  assert.throws(() => resolveModuleIds(bundle + bundle, MODULE_SIGNATURES), /contract is unclear/);
  const { host, converter } = await nativeHost();
  assert.equal(host.key("fixture-host", "agent-one"), "agent:fixture-host:agent-one");
  assert.equal(host.hasAgent("fixture-host", "agent-one"), true);
  assert.equal(host.hasAgent("wrong-host", "agent-one"), false);
  const text = formatQuote({ text: "第一行\n<script>不执行</script>\n第三行", code: null });
  const quote = makeQuote(text, "原始引用", "paseo://app/h/fixture-host/workspace/workspace-one");
  host.validateAttachment(quote);
  const converted = z.object({ type: z.string(), mimeType: z.string(), text: z.string(), externalResource: z.object({ provider: z.string(), id: z.string() }) }).parse(converter(quote));
  assert.deepEqual(converted, { type: "text", mimeType: "text/plain", text, externalResource: { provider: "quote-notes", id: quote.item.id } });
});

test("已编辑正文的延迟发布保留新增引用和其他附件", async () => {
  const { host, store, getState, Publication } = await nativeHost();
  const { binding, input, dom } = setup();
  const key = host.key(binding.hostId, binding.agentId);
  const other = { kind: "workspace_file", path: "src/example.ts", selection: { kind: "whole_file" } };
  host.save(key, { text: "旧正文", attachments: [other] });
  const textNotifications: string[] = [];
  let previousText = host.read(key)?.text;
  const unsubscribe = store.subscribe(() => {
    const current = host.read(key)?.text;
    if (current !== previousText) { previousText = current; textNotifications.push(current ?? ""); }
  });
  let publication: (() => void) | null = null;
  const staged = new Publication((text) => { getState().editDraftText({ draftKey: key, text }); }, { schedule(callback) { publication = callback; return () => {}; } });
  input.value = "正在编辑的新正文";
  staged.stage(input.value);
  const quote = makeQuote("> 引用全文", "引用全文", dom.window.location.href);
  assert.equal((await mutateQuotes({ host, binding, change: { kind: "add", attachment: quote } })).kind, "committed");
  assert.equal(input.value, "正在编辑的新正文");
  assert.equal(host.read(key)?.text, "旧正文");
  assert.deepEqual(textNotifications, []);
  assert.equal(typeof publication, "function");
  staged.flush();
  assert.deepEqual(host.read(key), { text: "正在编辑的新正文", attachments: [other, quote] });
  assert.deepEqual(textNotifications, ["正在编辑的新正文"]);
  unsubscribe();
  await host.flush();
  dom.window.close();
});

test("新草稿保留可见正文；按 ID 幂等添加和删除且不恢复已发送附件", async () => {
  const { host, getState } = await nativeHost();
  const { binding, input, dom } = setup();
  const key = host.key(binding.hostId, binding.agentId);
  input.value = "尚未发布的正文";
  const first = makeQuote("> 同一段文字", "同一段文字", dom.window.location.href);
  const second = makeQuote("> 同一段文字", "同一段文字", dom.window.location.href);
  for (const attachment of [first, first, second]) assert.equal((await mutateQuotes({ host, binding, change: { kind: "add", attachment } })).kind, "committed");
  assert.equal(host.read(key)?.text, input.value);
  assert.equal(readQuotes(host.read(key)).length, 2);
  assert.equal((await mutateQuotes({ host, binding, change: { kind: "remove", id: first.item.id } })).kind, "committed");
  assert.deepEqual(readQuotes(host.read(key)).map((entry) => entry.item.id), [second.item.id]);
  getState().clearDraftInput({ draftKey: key, lifecycle: "sent" });
  input.value = "新的正文";
  await mutateQuotes({ host, binding, change: { kind: "add", attachment: first } });
  assert.deepEqual(host.read(key), { text: "新的正文", attachments: [first] });
  await host.flush();
  dom.window.close();
});

test("hydrate 等待中切换 agent 或锁定输入框不写入任何会话", async () => {
  const { host } = await nativeHost();
  for (const changeScope of [true, false]) {
    const { binding, input, dom } = setup();
    let resume: (() => void) | undefined;
    let writes = 0;
    const delayed: DraftHost = { ...host, hydrate: () => new Promise<void>((resolve) => { resume = resolve; }), save: () => { writes += 1; } };
    const pending = mutateQuotes({ host: delayed, binding, change: { kind: "add", attachment: makeQuote("> 引用", "引用", dom.window.location.href) } });
    if (changeScope) dom.window.document.querySelector('[aria-selected="true"]')?.setAttribute("data-testid", "workspace-tab-agent_agent-two");
    else input.readOnly = true;
    resume?.();
    assert.deepEqual(await pending, { kind: "not-written", reason: "The composer is locked or the chat changed.", fallback: false });
    assert.equal(writes, 0);
    dom.window.close();
  }
});

test("失败只在写前允许 Markdown fallback；写后异常和 flush 失败均不允许重加", async () => {
  const { host } = await nativeHost();
  const { binding, dom } = setup();
  const quote = makeQuote("> 引用", "引用", dom.window.location.href);
  const input = { host, binding, change: { kind: "add", attachment: quote } } satisfies Parameters<typeof mutateQuotes>[0];
  const unsupported = await mutateQuotes({ ...input, host: { ...host, validateAttachment() { throw new Error("schema mismatch"); } } });
  assert.deepEqual(unsupported, { kind: "not-written", reason: "schema mismatch", fallback: true });
  const saveThrows = await mutateQuotes({ ...input, host: { ...host, save(key, value) { host.save(key, value); throw new Error("after write"); } } });
  assert.equal(saveThrows.kind, "uncertain");
  assert.equal(readQuotes(host.read(host.key(binding.hostId, binding.agentId))).length, 1);
  const second = makeQuote("> 另一个引用", "另一个引用", dom.window.location.href);
  const flushThrows = await mutateQuotes({ ...input, change: { kind: "add", attachment: second }, host: { ...host, flush: async () => { throw new Error("disk error"); } } });
  assert.equal(flushThrows.kind, "uncertain");
  assert.equal(readQuotes(host.read(host.key(binding.hostId, binding.agentId))).length, 2);
  await host.flush();
  dom.window.close();
});

test("chip 从原生草稿派生计数、只读预览、Esc 避开宿主 window 捕获、按 ID 移除和清理", async () => {
  const { host, resolveKeyboardFocusScope } = await nativeHost();
  const { binding, input, anchor, wrapper, dom } = setup();
  const key = host.key(binding.hostId, binding.agentId);
  host.save(key, { text: "保留的补充问题", attachments: [] });
  const plugin = installQuoteComposer({ discover: async () => host });
  await plugin.add({ composer: input, anchor, agentId: "agent-one", formattedText: "> <img src=x onerror=alert(1)>", preview: "第一段" });
  await plugin.add({ composer: input, anchor, agentId: "agent-one", formattedText: "> 第二段全文", preview: "第二段" });
  assert.equal(dom.window.document.activeElement, input);
  const entries = readQuotes(host.read(key));
  const tray = dom.window.document.createElement("div");
  tray.setAttribute("data-testid", "composer-attachment-tray");
  for (const entry of entries) {
    const frame = dom.window.document.createElement("div");
    const pill = dom.window.document.createElement("div");
    pill.setAttribute("data-testid", "composer-plugin-resource-attachment-pill");
    pill.textContent = `引用 ${entry.item.identifier}`;
    const nativeRemove = dom.window.document.createElement("button");
    nativeRemove.textContent = "×";
    frame.append(pill, nativeRemove);
    tray.append(frame);
  }
  wrapper.prepend(tray);
  await settle();
  const chip = wrapper.querySelector("[data-paseo-quote-chip]");
  const button = chip?.shadowRoot?.querySelector("button");
  assert.equal(button?.textContent, "2 annotations");
  assert.equal(tray.hasAttribute("data-paseo-quote-hidden"), true);
  assert.equal(tray.children[0].hasAttribute("data-paseo-quote-hidden"), true);
  assert.equal(input.value, "");
  assert.equal(host.read(key)?.text, "保留的补充问题");
  button?.click();
  const preview = dom.window.document.querySelector("[data-paseo-quote-preview]");
  assert.equal(preview?.shadowRoot?.querySelector("img"), null);
  assert.equal(preview?.shadowRoot?.querySelector("pre")?.textContent, "> <img src=x onerror=alert(1)>");
  let escaped = 0;
  const nativeScopes: unknown[] = [];
  dom.window.addEventListener("keydown", (event) => { nativeScopes.push(resolveKeyboardFocusScope({ target: event.target, commandCenterOpen: false })); }, true);
  dom.window.document.addEventListener("keydown", () => { escaped += 1; });
  const edit = new dom.window.InputEvent("beforeinput", { inputType: "insertText", data: "unexpected", bubbles: true, composed: true, cancelable: true });
  preview?.shadowRoot?.querySelector("pre")?.dispatchEvent(edit);
  assert.equal(edit.defaultPrevented, true);
  preview?.shadowRoot?.querySelector("button")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  assert.equal(escaped, 0);
  assert.deepEqual(nativeScopes, ["editable"]);
  assert.equal(dom.window.document.querySelector("[data-paseo-quote-preview]"), null);
  button?.click();
  const remove = dom.window.document.querySelector("[data-paseo-quote-preview]")?.shadowRoot?.querySelector(".remove");
  if (!(remove instanceof dom.window.HTMLButtonElement)) throw new Error("Missing remove button");
  remove.click();
  await settle();
  assert.deepEqual(readQuotes(host.read(key)).map((entry) => entry.item.id), [entries[1].item.id]);
  assert.equal(button?.textContent, "1 annotation");
  const other = dom.window.document.createElement("div");
  other.textContent = "其他附件";
  tray.append(other);
  await settle();
  assert.equal(tray.hasAttribute("data-paseo-quote-hidden"), false);
  plugin.dispose();
  await settle();
  assert.equal(wrapper.querySelector("[data-paseo-quote-chip]"), null);
  assert.equal(dom.window.document.querySelector("[data-paseo-quote-hidden]"), null);
  assert.equal(dom.window.document.querySelector("[data-paseo-quote-preview]"), null);
  assert.equal(readQuotes(host.read(key)).length, 1);
  await host.flush();
  dom.window.close();
});

test("host 路由解析只提供 host，agent 必须经 pane 和目录独立确认", () => {
  assert.equal(currentHostId("paseo://app/h/server-a/workspace/workspace-b"), "server-a");
  assert.equal(currentHostId("paseo://app/settings"), null);
  const { dom, input, anchor } = setup();
  assert.equal(bindComposer(input, anchor, "agent-two"), null);
  dom.window.close();
});

 test("selected node removal preserves transcript draft binding and chip mounts in inner card", async () => {
  const { host } = await nativeHost();
  const { binding, input, anchor, wrapper, dom } = setup();
  const plugin = installQuoteComposer({ discover: async () => host });
  const added = await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original" });
  assert.equal(wrapper.querySelector("[data-paseo-quote-chip]")?.parentElement, wrapper);
  if (added.kind === "not-written") throw new Error(added.reason);
  anchor.remove();
  assert.equal(writeQuoteComment({ host, ref: added.ref, comment: "still editable" }).kind, "committed");
  plugin.dispose(); await host.flush(); dom.window.close();
});

test("middle removal preserves keyed rows and scroll; summary follows current chip; offscreen editor retains field", async () => {
  const { host } = await nativeHost();
  const { binding, input, anchor, wrapper, dom } = setup();
  const rect = (x: number, y: number, width: number, height: number) => new dom.window.DOMRect(x, y, width, height);
  let selectionRect = rect(100, 200, 100, 20);
  binding.anchor.getBoundingClientRect = () => rect(30, 30, 500, 450);
  wrapper.getBoundingClientRect = () => rect(30, 480, 500, 100);
  dom.window.Range.prototype.getClientRects = () => Object.assign([selectionRect], { item: () => selectionRect });
  dom.window.Range.prototype.getBoundingClientRect = () => selectionRect;
  const range = dom.window.document.createRange(); range.selectNodeContents(anchor);
  const plugin = installQuoteComposer({ discover: async () => host });
  const key = host.key(binding.hostId, binding.agentId);
  const other = { kind: "workspace_file", path: "keep.txt", selection: { kind: "whole_file" } };
  host.save(key, { text: "unchanged body", attachments: [other] });
  for (let i = 0; i < 3; i++) await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: `> quote ${i}`, preview: `quote ${i}`, sourceRange: range });
  const button = wrapper.querySelector("[data-paseo-quote-chip]")?.shadowRoot?.querySelector("button");
  if (!button) throw new Error("Missing chip");
  let chipRect = rect(80, 500, 90, 29); button.getBoundingClientRect = () => chipRect;
  button.click();
  const summary = dom.window.document.querySelector<HTMLElement>("[data-paseo-quote-preview]");
  const rows = Array.from(summary?.shadowRoot?.querySelectorAll(".entry") ?? []);
  const list = summary?.shadowRoot?.querySelector<HTMLElement>(".entries");
  if (!summary || !list) throw new Error("Missing summary");
  list.scrollTop = 24;
  const middleRemove = rows[1].querySelector<HTMLButtonElement>(".remove"); middleRemove?.focus(); middleRemove?.click();
  await settle();
  assert.equal(summary.isConnected, true);
  assert.equal(list.children[1], rows[2]); assert.equal(list.scrollTop, 24);
  assert.equal(summary.shadowRoot?.activeElement, rows[2].querySelector(".remove"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const top = summary.style.top;
  chipRect = rect(180, 400, 90, 29); dom.window.dispatchEvent(new dom.window.Event("resize"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.notEqual(summary.style.top, top);
  rows[0].querySelector<HTMLButtonElement>(".edit")?.click();
  const editor = dom.window.document.querySelector<HTMLElement>("[data-paseo-quote-editor]");
  const field = editor?.querySelector("textarea");
  if (!field) throw new Error("Missing editor");
  field.value = "keep typed comment"; field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(editor?.shadowRoot?.querySelector(".location")?.textContent, "");
  selectionRect = rect(100, -100, 100, 20); binding.anchor.dispatchEvent(new dom.window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(editor?.querySelector("textarea"), field); assert.equal(field.value, "keep typed comment");
  assert.equal(editor?.shadowRoot?.querySelector(".location")?.textContent, "Source is out of view");
  anchor.remove();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(editor?.querySelector("textarea"), field);
  assert.equal(editor?.shadowRoot?.querySelector(".location")?.textContent, "Source location unavailable");
  assert.equal(host.read(key)?.text, "unchanged body"); assert.deepEqual(host.read(key)?.attachments[0], other);
  plugin.dispose();
  assert.equal(dom.window.document.querySelector("[data-paseo-quote-source],[data-paseo-quote-editor],[data-paseo-quote-preview]"), null);
  await host.flush(); dom.window.close();
});

test("unvalidated card leaves native pills visible", async () => {
  const { host } = await nativeHost();
  const { input, anchor, wrapper, dom } = setup();
  wrapper.style.border = "none";
  const plugin = installQuoteComposer({ discover: async () => host });
  const added = await plugin.add({ composer: input, anchor, agentId: "agent-one", formattedText: "> quote", preview: "quote" });
  assert.notEqual(added.kind, "not-written");
  assert.equal(wrapper.querySelector("[data-paseo-quote-chip]"), null);
  assert.equal(dom.window.document.querySelector("[data-paseo-quote-hidden]"), null);
  plugin.dispose(); await host.flush(); dom.window.close();
});

for (const pendingFlush of [false, true]) {
  test(`ready create editor closes after external removal with pending comment flush ${pendingFlush}`, async () => {
    const { host } = await nativeHost();
    const { binding, input, anchor, dom } = setup();
    const key = host.key(binding.hostId, binding.agentId);
    let holdFlush = false, writes = 0;
    let release: (() => void) | undefined;
    const controlled: DraftHost = { ...host,
      save(draftKey, value) { writes++; host.save(draftKey, value); },
      async flush() {
        if (holdFlush) await new Promise<void>((resolve) => { release = resolve; });
        await host.flush();
      },
    };
    const plugin = installQuoteComposer({ discover: async () => controlled });
    try {
      const added = await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original", openComment: true });
      assert.equal(added.kind, "committed");
      const editor = dom.window.document.querySelector<HTMLElement>("[data-paseo-quote-editor]");
      const field = editor?.querySelector("textarea");
      if (!editor || !field) throw new Error("Missing create editor");
      field.value = "comment before external removal";
      if (pendingFlush) {
        holdFlush = true;
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await settle();
        assert.equal(typeof release, "function");
      }
      const externalDraft = { text: "", attachments: [] };
      host.save(key, externalDraft);
      const writesBeforeClose = writes;
      await settle(); await new Promise((resolve) => setTimeout(resolve, 35));
      assert.equal(editor.isConnected, false, "a removed or sent quote must close the ready create editor");
      field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
      holdFlush = false; release?.();
      await settle(); await new Promise((resolve) => setTimeout(resolve, 35));
      assert.equal(dom.window.document.querySelector("[data-paseo-quote-editor]"), null);
      assert.equal(writes, writesBeforeClose, "dismissal and late flush must not write a removed quote");
      assert.deepEqual(host.read(key), externalDraft);
    } finally { holdFlush = false; release?.(); plugin.dispose(); await host.flush(); dom.window.close(); }
  });
}

test("late add completion never reopens an editor after host or pane changes", async () => {
  const { host } = await nativeHost();
  for (const change of ["host", "pane"] as const) {
    const { binding, input, anchor, dom } = setup();
    let resume: (() => void) | undefined;
    const plugin = installQuoteComposer({ discover: async () => ({ ...host, flush: () => new Promise<void>((resolve) => { resume = resolve; }) }) });
    const adding = plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original", openComment: true });
    await settle();
    assert.equal(typeof resume, "function");
    dom.window.document.querySelector("[data-paseo-quote-editor] textarea")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    const original = readQuotes(host.read(host.key(binding.hostId, binding.agentId))).map((entry) => entry.item.id);
    if (change === "host") dom.window.history.replaceState({}, "", "/h/another-host/workspace/workspace-one");
    else { const pane = dom.window.document.createElement("div"); pane.setAttribute("data-testid", "workspace-pane-two"); dom.window.document.body.append(pane); pane.append(input); }
    resume?.();
    assert.equal((await adding).kind, "uncertain");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(dom.window.document.querySelector("[data-paseo-quote-editor]"), null);
    assert.deepEqual(readQuotes(host.read(host.key(binding.hostId, binding.agentId))).map((entry) => entry.item.id), original);
    assert.equal(host.read(host.key("another-host", binding.agentId)), undefined);
    plugin.dispose(); dom.window.close();
  }
  await host.flush();
});

test("uncertain add with no readback retains the field and retries the same attachment ID", async () => {
  const { host } = await nativeHost();
  const { binding, input, anchor, dom } = setup();
  let fail = true;
  const attempts: string[] = [];
  const controlled: DraftHost = { ...host, save(key, value) {
    attempts.push(readQuotes(value).at(-1)?.item.id ?? "");
    if (fail) throw new Error("before native save");
    host.save(key, value);
  } };
  const plugin = installQuoteComposer({ discover: async () => controlled });
  const adding = plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original", openComment: true });
  const editor = dom.window.document.querySelector("[data-paseo-quote-editor]");
  const field = editor?.querySelector("textarea");
  if (!field) throw new Error("Missing immediate field");
  field.value = "retain this comment";
  assert.equal((await adding).kind, "uncertain");
  await settle(); assert.equal(editor?.isConnected, true);
  fail = false;
  editor?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click();
  await settle();
  assert.equal(new Set(attempts).size, 1);
  const quotes = readQuotes(host.read(host.key(binding.hostId, binding.agentId)));
  assert.equal(quotes.length, 1); assert.equal(quotes[0].item.subtitle, field.value);
  plugin.dispose(); await host.flush(); dom.window.close();
});

for (const finish of ["Escape", "Enter", "button", "outside"] as const) {
  for (const failure of ["hydrate", "save", "flush"] as const) {
    test(`pending add ${finish} retains comment through ${failure} failure and same-ID retry`, async () => {
      const { host } = await nativeHost();
      const { binding, input, anchor, dom } = setup();
      let fail = true;
      let resume!: (host: DraftHost) => void;
      const attempts: string[] = [];
      const controlled: DraftHost = { ...host,
        async hydrate(signal) { if (fail && failure === "hydrate") throw new Error("hydrate failed"); await host.hydrate(signal); },
        save(key, value) {
          attempts.push(readQuotes(value).at(-1)?.item.id ?? "");
          if (fail && failure === "save") throw new Error("before native save");
          host.save(key, value);
        },
        async flush() { if (fail && failure === "flush") throw new Error("flush failed"); await host.flush(); },
      };
      const plugin = installQuoteComposer({ discover: () => new Promise<DraftHost>((resolve) => { resume = resolve; }) });
      try {
        const adding = plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original", openComment: true });
        const editor = dom.window.document.querySelector("[data-paseo-quote-editor]");
        const field = editor?.querySelector("textarea");
        const retry = editor?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="retry"]');
        if (!field || !retry) throw new Error("Missing editor");
        field.value = "retain pending comment";
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        const finishEditor = () => {
          if (finish === "button") editor?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="finish"]')?.click();
          else if (finish === "outside") input.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, composed: true }));
          else field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: finish, bubbles: true, composed: true, cancelable: true }));
        };
        finishEditor();
        resume(controlled);
        assert.equal((await adding).kind, failure === "hydrate" ? "not-written" : "uncertain");
        await settle();
        assert.equal(editor?.isConnected, true);
        assert.equal(retry.hidden, false);
        assert.equal(field.value, "retain pending comment");
        assert.equal(readQuotes(host.read(host.key(binding.hostId, binding.agentId))).length, failure === "flush" ? 1 : 0);
        finishEditor();
        await settle();
        assert.equal(editor?.isConnected, true);
        assert.equal(retry.hidden, false);
        fail = false;
        retry.click();
        await settle();
        assert.equal(new Set(attempts).size, 1);
        const quotes = readQuotes(host.read(host.key(binding.hostId, binding.agentId)));
        assert.equal(quotes.length, 1);
        assert.equal(quotes[0].item.subtitle, "retain pending comment");
        assert.equal(editor?.isConnected, false);
      } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
    });
  }
}

for (const phase of ["adding", "saving"] as const) {
  for (const resumeWith of ["input", "composition"] as const) {
    test(`resumed ${resumeWith} cancels pending finish while ${phase}`, async () => {
      const { host } = await nativeHost();
      const { binding, input, anchor, dom } = setup();
      let resumeDiscovery!: (value: DraftHost) => void;
      let holdFlush = false;
      const flushes: Array<() => void> = [];
      const controlled: DraftHost = { ...host, flush: () => holdFlush
        ? new Promise<void>((resolve) => { flushes.push(resolve); }) : host.flush() };
      const plugin = installQuoteComposer({ discover: phase === "adding"
        ? () => new Promise<DraftHost>((resolve) => { resumeDiscovery = resolve; })
        : async () => controlled });
      try {
        const adding = plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original", openComment: true });
        if (phase === "saving") { await adding; holdFlush = true; }
        const editor = dom.window.document.querySelector("[data-paseo-quote-editor]");
        const field = editor?.querySelector("textarea");
        if (!field) throw new Error("Missing editor");
        field.value = "old";
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
        if (resumeWith === "composition") field.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
        field.value = resumeWith === "composition" ? "old拼" : "old continued";
        field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, isComposing: resumeWith === "composition" }));
        holdFlush = false;
        if (phase === "adding") resumeDiscovery(controlled);
        for (const flush of flushes) flush();
        await adding; await settle();
        assert.equal(editor?.isConnected, true, "resumed editing must keep the comment field open");
        assert.equal(dom.window.document.activeElement, field);
        if (resumeWith === "composition") {
          field.value = "old拼音";
          field.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
          await settle();
        }
        const quotes = readQuotes(host.read(host.key(binding.hostId, binding.agentId)));
        assert.equal(quotes[0].item.subtitle, field.value);
        field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
        await settle();
        assert.equal(editor?.isConnected, false);
      } finally {
        holdFlush = false; for (const flush of flushes) flush();
        plugin.dispose(); await host.flush(); dom.window.close();
      }
    });
  }
}

for (const surface of ["editor", "preview"] as const) {
  test(`${surface} stays inside the owning pane when its source is unavailable`, async () => {
    const { host } = await nativeHost();
    const { binding, input, anchor, wrapper, dom } = setup();
    binding.pane.getBoundingClientRect = () => new dom.window.DOMRect(500, 100, 400, 650);
    const plugin = installQuoteComposer({ discover: async () => host });
    try {
      await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> original", preview: "original", openComment: surface === "editor" });
      const chip = wrapper.querySelector("[data-paseo-quote-chip]")?.shadowRoot?.querySelector("button");
      if (!chip) throw new Error("Missing chip");
      chip.getBoundingClientRect = () => new dom.window.DOMRect(520, 650, 90, 29);
      if (surface === "preview") chip.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const overlay = dom.window.document.querySelector<HTMLElement>(`[data-paseo-quote-${surface}]`);
      if (!overlay) throw new Error("Missing overlay");
      assert.ok(parseFloat(overlay.style.left) >= 508, `${surface} must stay inside its chat pane`);
      assert.ok(parseFloat(overlay.style.left) + parseFloat(overlay.style.width) <= 892);
    } finally { plugin.dispose(); await host.flush(); dom.window.close(); }
  });
}
