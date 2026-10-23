import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { decodeAnnotation, encodeAnnotation } from "../client/format";
import { makeQuote, mutateQuotes, quoteAttachmentSchema, readQuotes, writeQuoteComment, type DraftHost } from "../client/host-draft-bridge";
import { installQuoteComposer } from "../client/quote-composer";
import { nativeHost } from "./native-host";
import { fixtureOwner, setup, settle } from "./dom";

test("评论 codec 保留原文、空评论、多行和相同 suffix，旧引用不猜分隔", () => {
  for (const quote of ["> 原文\n\n尾句", "```ts\n  const answer = 42;\n```\n", "> 尾句\n\n尾句"]) {
    for (const comment of ["", "尾句", "第一行\n第二行  \n", "\n\n尾句"]) {
      const encoded = encodeAnnotation({ quote, comment });
      assert.deepEqual(decodeAnnotation(encoded), { kind: "editable", annotation: { quote, comment } });
      assert.equal(Object.hasOwn(encoded, "subtitle"), comment.length > 0);
    }
    assert.deepEqual(decodeAnnotation({ text: quote }), { kind: "editable", annotation: { quote, comment: "" } });
  }
  assert.equal(decodeAnnotation({ text: "> 原文\n\n不同结尾", subtitle: "评论" }).kind, "invalid");
  assert.equal(decodeAnnotation({ text: "> 原文\n\n", subtitle: "" }).kind, "invalid");
});

for (const pluginId of ["quote", "quote-notes"]) {
  test(`${pluginId} 真实原生评论更新、flush、恢复和 converter 保留身份、评论和其他附件`, async () => {
    const { host, storage, converter } = await nativeHost();
    const { binding, dom } = setup();
    const key = host.key(binding.hostId, binding.agentId);
    const other = { kind: "workspace_file", path: "keep.txt", selection: { kind: "whole_file" } };
    const created = makeQuote("> 原文\n\n同一句", "原文", dom.window.location.href);
    const quote = quoteAttachmentSchema.parse({ ...created, pluginId });
    const original = structuredClone(quote);
    host.save(key, { text: "正文不能污染", attachments: [other] });
    await mutateQuotes({ host, binding, change: { kind: "add", attachment: quote } });
    const ref = { id: quote.item.id, binding };
    const comment = "同一句\n\n多行评论  \n";
    assert.equal(writeQuoteComment({ host, ref, comment }).kind, "committed");
    const updated = readQuotes(host.read(key))[0];
    assert.equal(updated.pluginId, pluginId);
    assert.deepEqual(quote, original);
    assert.equal(updated.item.id, quote.item.id);
    assert.equal(updated.item.subtitle, comment);
    assert.equal(updated.item.text, "> 原文\n\n同一句\n\n同一句\n\n多行评论  \n");
    assert.deepEqual(host.read(key), { text: "正文不能污染", attachments: [other, updated] });
    assert.deepEqual(z.object({ text: z.string(), externalResource: z.object({ provider: z.string(), id: z.string() }) }).parse(converter(updated)), {
      text: updated.item.text, externalResource: { provider: pluginId, id: quote.item.id },
    });
    await host.flush();
    const persisted = [...storage.values()].map((value) => JSON.parse(value));
    assert.equal(persisted.some((value) => JSON.stringify(value).includes("多行评论")), true);
    const restored = await nativeHost(storage);
    await restored.host.hydrate(key);
    assert.deepEqual(restored.host.read(key), host.read(key));
    assert.equal(readQuotes(restored.host.read(key)).length, 1);
    assert.equal(writeQuoteComment({ host: restored.host, ref, comment: "" }).kind, "committed");
    assert.equal(readQuotes(restored.host.read(key))[0].item.text, quote.item.text);
    assert.equal(Object.hasOwn(readQuotes(restored.host.read(key))[0].item, "subtitle"), false);
    assert.equal(readQuotes(restored.host.read(key))[0].pluginId, pluginId);
    assert.deepEqual(restored.host.read(key)?.attachments[0], other);
    await restored.host.flush();
    dom.window.close();
  });
}

test("更新最新 raw 附件保留未知字段，完整核验写入，格式不匹配拒绝覆盖", async () => {
  const { host } = await nativeHost();
  const { binding, dom } = setup();
  const key = host.key(binding.hostId, binding.agentId);
  const quote = quoteAttachmentSchema.parse({ ...makeQuote("> legacy\n\n全文含旧评论", "旧引用", dom.window.location.href), pluginId: "quote" });
  const other = { kind: "workspace_file", path: "keep.txt", selection: { kind: "whole_file" } };
  const draftSchema = z.object({ text: z.string(), attachments: z.array(z.unknown()), futureDraft: z.string() });
  let draft = draftSchema.parse({ text: "正文", attachments: [{ ...quote, futureAttachment: 1, item: { ...quote.item, futureItem: { keep: true } } }, other], futureDraft: "keep" });
  const current = () => readQuotes(draft)[0];
  const rawHost: DraftHost = { ...host, read: () => draft, save: (_key, value) => { draft = draftSchema.parse(value); } };
  const ref = { id: quote.item.id, binding };
  assert.equal(writeQuoteComment({ host: { ...rawHost, hasAgent() { throw new Error("fixture session schema"); } }, ref, comment: "边界失败" }).kind, "not-written");
  assert.equal(current().item.subtitle, undefined);
  assert.equal(writeQuoteComment({ host: rawHost, ref, comment: "新评论" }).kind, "committed");
  assert.equal(draft.futureDraft, "keep");
  assert.equal(current().pluginId, "quote");
  assert.equal(current().futureAttachment, 1);
  assert.deepEqual(current().item.futureItem, { keep: true });
  assert.equal(current().item.text, "> legacy\n\n全文含旧评论\n\n新评论");
  assert.deepEqual(draft.attachments[1], other);
  assert.equal(writeQuoteComment({ host: { ...rawHost, save() {} }, ref, comment: "丢失写入" }).kind, "uncertain");
  draft.attachments[0] = { ...current(), item: { ...current().item, subtitle: "不匹配的评论" } };
  const before = structuredClone(draft);
  assert.equal(writeQuoteComment({ host: rawHost, ref, comment: "不能覆盖" }).kind, "not-written");
  assert.deepEqual(draft, before);
  assert.equal(host.read(key), undefined);
  dom.window.close();
});

test("连续输入同步写最新值，旧 flush 结果不恢复已移除或发送附件，切会话可返回重试", async () => {
  const { host, getState } = await nativeHost();
  const { binding, input, anchor, dom } = setup();
  let holdFlush = false;
  const flushes: Array<() => void> = [];
  const controlled: DraftHost = { ...host, flush: () => holdFlush ? new Promise<void>((resolve) => flushes.push(resolve)) : host.flush() };
  const plugin = installQuoteComposer({ owner: fixtureOwner, discover: async () => controlled });
  const added = await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> 原文", preview: "原文" });
  if (added.kind !== "committed") throw new Error("Fixture add failed");
  const key = host.key(binding.hostId, binding.agentId);
  holdFlush = true;
  const first = plugin.setComment(added.ref, "一");
  const second = plugin.setComment(added.ref, "一二三尾字");
  assert.equal(readQuotes(host.read(key))[0].item.subtitle, "一二三尾字");
  assert.equal(readQuotes(host.read(key)).length, 1);
  flushes[1]();
  await second;
  getState().clearDraftInput({ draftKey: key, lifecycle: "sent" });
  flushes[0]();
  await first;
  assert.equal(readQuotes(host.read(key)).length, 0);
  assert.equal((await plugin.setComment(added.ref, "迟到输入")).kind, "not-written");
  assert.equal(readQuotes(host.read(key)).length, 0);
  holdFlush = false;
  const next = await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> 第二段", preview: "第二段" });
  if (next.kind !== "committed") throw new Error("Fixture second add failed");
  const tab = dom.window.document.querySelector('[aria-selected="true"]');
  tab?.setAttribute("data-testid", "workspace-tab-agent_agent-two");
  assert.equal((await plugin.setComment(next.ref, "切会话时未保存的尾字")).kind, "not-written");
  assert.equal(readQuotes(host.read(key))[0].item.subtitle, undefined);
  assert.equal(host.read(host.key(binding.hostId, "agent-two")), undefined);
  tab?.setAttribute("data-testid", "workspace-tab-agent_agent-one");
  assert.equal((await plugin.setComment(next.ref, "返回原会话重试")).kind, "committed");
  await mutateQuotes({ host, binding, change: { kind: "remove", id: next.ref.id } });
  assert.equal((await plugin.setComment(next.ref, "删除后的迟到输入")).kind, "not-written");
  assert.equal(readQuotes(host.read(key)).length, 0);
  plugin.dispose();
  await host.flush();
  dom.window.close();
});

test("compact summary opens staged editing with editable host, IME and Escape discarding the buffer", async () => {
  const { host, resolveKeyboardFocusScope } = await nativeHost();
  const { binding, input, anchor, wrapper, dom } = setup();
  const plugin = installQuoteComposer({ owner: fixtureOwner, discover: async () => host });
  await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> 原文", preview: "原文" });
  const chip = wrapper.querySelector("[data-paseo-quote-chip]")?.shadowRoot?.querySelector("button");
  chip?.click();
  const summary = dom.window.document.querySelector("[data-paseo-quote-preview]");
  assert.equal(summary?.querySelector("textarea"), null);
  const edit = summary?.shadowRoot?.querySelector<HTMLButtonElement>(".edit");
  edit?.click();
  const editor = dom.window.document.querySelector("[data-paseo-quote-editor]");
  const field = editor?.querySelector("textarea");
  if (!field) throw new Error("Missing comment field");
  const scopes: unknown[] = [];
  dom.window.addEventListener("keydown", (event) => scopes.push(resolveKeyboardFocusScope({ target: event.target, commandCenterOpen: false })), true);
  field.value = "修改评论\n第二行";
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  field.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
  for (const key of ["Enter", "Escape"]) {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
    field.dispatchEvent(event); assert.equal(event.defaultPrevented, false); assert.equal(editor?.isConnected, true);
  }
  field.value += "，输入法尾字";
  field.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  assert.deepEqual(scopes, ["editable", "editable", "editable"]);
  await settle();
  assert.equal(editor?.isConnected, false);
  chip?.click();
  if (!dom.window.document.querySelector("[data-paseo-quote-preview]")) chip?.click();
  const reopened = dom.window.document.querySelector("[data-paseo-quote-preview]");
  assert.equal(reopened?.shadowRoot?.querySelector(".comment")?.textContent, "");
  const quotes = readQuotes(host.read(host.key(binding.hostId, binding.agentId)));
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].item.subtitle, undefined);
  assert.equal(quotes[0].item.text, "> 原文");
  plugin.dispose(); await host.flush(); dom.window.close();
});
