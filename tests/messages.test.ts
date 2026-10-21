import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnnotationPreferences } from "../client/annotation-preferences";
import { decodeExternal, encodeExternal, type ExternalSnapshot } from "../client/external-origin";
import { decodeAnnotation } from "../client/format";
import { MODULE_SIGNATURES, makeQuote, mutateQuotes, quoteAttachmentSchema, readQuotes, resolveModuleIds, writeQuoteComment } from "../client/host-draft-bridge";
import { acceptedQuoteSourceTitles, acceptedSourcePrefixes, describeError, LocalizedError, messages, text } from "../client/messages";
import { installQuoteComposer } from "../client/quote-composer";
import { startSideChat } from "../client/actions";
import { nativeHost } from "./native-host";
import { setup, settle } from "./dom";

function switchableLanguage(initial: "en" | "zh") {
  let locale = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => locale,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: "en" | "zh") { locale = next; for (const listener of [...listeners]) listener(); },
    listeners: () => listeners.size,
  };
}

// Produced by origin/main's encodeExternal and makeQuote (Chinese only, before the locale switch).
const legacyExternal = {
  url: "https://paseo.sh/h/server/workspace/one#paseo-annotation=%7B%22v%22%3A1%2C%22origin%22%3A%7B%22kind%22%3A%22file%22%2C%22workspace%22%3A%7B%22serverId%22%3A%22server%22%2C%22workspaceId%22%3A%22workspace%22%2C%22workspaceKey%22%3A%22key%22%2C%22root%22%3A%22%2Frepo%22%7D%2C%22tabId%22%3A%22tab%22%2C%22file%22%3A%7B%22requestedPath%22%3A%22src%2Fa.ts%22%2C%22absolutePath%22%3A%22%2Frepo%2Fsrc%2Fa.ts%22%2C%22relativePath%22%3A%22src%2Fa.ts%22%7D%2C%22from%22%3A0%2C%22to%22%3A5%2C%22lineStart%22%3A1%2C%22lineEnd%22%3A1%2C%22version%22%3A%7B%22algorithm%22%3A%22sha256%22%2C%22digest%22%3A%22aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%22%7D%7D%2C%22prefix%22%3A%22%E5%BC%95%E7%94%A8%E6%9D%A5%E6%BA%90%EF%BC%9Asrc%2Fa.ts%3A1-1%5Cn%5Cn%22%2C%22suffix%22%3A%22%22%7D",
  text: "引用来源：src/a.ts:1-1\n\nconst",
};
const legacyQuote = {
  kind: "plugin_resource", pluginId: "quote-notes", sourceId: "selection-v1", sourceTitle: "引用", sourceIcon: "MessageSquareQuote",
  item: { id: "cfefe8bf-7696-4d17-9829-b0ddbef4abb9", identifier: "quote-cfefe8bf-7696-4d17-9829-b0ddbef4abb9", title: "引用片段", url: "https://paseo.sh/h/server/workspace/one", text: "> a", resourceType: "quote" },
};

const zh = { getSnapshot: () => "zh" as const };
const origin: ExternalSnapshot["origin"] = {
  kind: "file",
  workspace: { serverId: "server", workspaceId: "workspace", workspaceKey: "key", root: "/repo" },
  tabId: "tab",
  file: { requestedPath: "src/a.ts", absolutePath: "/repo/src/a.ts", relativePath: "src/a.ts" },
  from: 0, to: 5, lineStart: 1, lineEnd: 1,
  version: { algorithm: "sha256", digest: "a".repeat(64) },
};
const snapshot: ExternalSnapshot = { text: "const", title: "src/a.ts:1-1", origin };
const sourceUrl = "https://paseo.sh/h/server/workspace/one";

test("English is the default and zh gives the Chinese text", () => {
  assert.equal(text().count(2), "2 annotations");
  assert.equal(text(zh).count(2), "2 条注释");
  assert.equal(text({ getSnapshot: () => "en" }).saved, "Saved");
  assert.equal(text(zh).saved, "已保存");
});

test("new quotes are written in the current locale", () => {
  const english = makeQuote("> a", "", sourceUrl);
  assert.equal(english.sourceTitle, "Quote");
  assert.equal(english.item.title, "Quote snippet");
  const chinese = makeQuote("> a", "", sourceUrl, zh);
  assert.equal(chinese.sourceTitle, "引用");
  assert.equal(chinese.item.title, "引用片段");
  assert.equal(decodeAnnotation({ text: "> a\n\n", subtitle: "" }).kind, "invalid");
  assert.match(String(Reflect.get(decodeAnnotation({ text: "> a", subtitle: "x" }), "reason")), /cannot be edited safely/);
  assert.match(String(Reflect.get(decodeAnnotation({ text: "> a", subtitle: "x" }, zh), "reason")), /无法安全编辑/);
});

test("stored source titles accept both locales and nothing else", () => {
  const legacy = quoteAttachmentSchema.parse(legacyQuote);
  const english = makeQuote("> b", "t", sourceUrl);
  const chineseWithEnglishTitle = { ...makeQuote("> c", "t", sourceUrl, zh), sourceTitle: "Quote" };
  assert.deepEqual(readQuotes({ text: "", attachments: [legacy, english, chineseWithEnglishTitle] }).map((quote) => quote.item.id), [legacy.item.id, english.item.id, chineseWithEnglishTitle.item.id]);
  assert.equal(quoteAttachmentSchema.safeParse({ ...english, sourceTitle: "Other" }).success, false);
});

test("accepted stored values include what every locale writes", () => {
  for (const [name, entry] of Object.entries(messages)) {
    assert.ok(acceptedQuoteSourceTitles.includes(entry.quoteSourceTitle), name);
    assert.ok(acceptedSourcePrefixes.includes(entry.sourcePrefix), name);
    assert.equal(quoteAttachmentSchema.safeParse(makeQuote("> a", "", sourceUrl, { getSnapshot: () => name as "en" | "zh" })).success, true, name);
  }
});

test("a quote and external fragment written by the old Chinese-only build decode in both locales", () => {
  for (const language of [undefined, zh]) {
    const decoded = decodeExternal(legacyExternal, language);
    assert.equal(decoded.kind, "external");
    if (decoded.kind === "external") {
      assert.equal(decoded.snapshot.title, "src/a.ts:1-1");
      assert.equal(decoded.snapshot.text, "const");
      assert.deepEqual(decoded.snapshot.origin, origin);
    }
    assert.deepEqual(decodeAnnotation(legacyQuote.item, language), { kind: "editable", annotation: { quote: "> a", comment: "" } });
  }
  assert.equal(readQuotes({ text: "", attachments: [legacyQuote] }).length, 1);
});

test("a legacy Chinese quote is still recognised, edited and removed in English mode", async () => {
  const { host } = await nativeHost();
  const { binding, dom } = setup();
  const key = host.key(binding.hostId, binding.agentId);
  host.save(key, { text: "", attachments: [] });
  const legacy = quoteAttachmentSchema.parse(legacyQuote);
  assert.equal((await mutateQuotes({ host, binding, change: { kind: "add", attachment: legacy } })).kind, "committed");
  const ref = { id: legacy.item.id, binding };
  assert.equal(writeQuoteComment({ host, ref, comment: "note" }).kind, "committed");
  const edited = readQuotes(host.read(key))[0];
  assert.equal(edited.sourceTitle, "引用");
  assert.equal(edited.item.subtitle, "note");
  assert.equal((await mutateQuotes({ host, binding, change: { kind: "remove", id: legacy.item.id } })).kind, "committed");
  assert.equal(readQuotes(host.read(key)).length, 0);
  dom.window.close();
});

test("discovery errors are described in the language current when shown", async () => {
  const language = switchableLanguage("en");
  const failure = new LocalizedError((entry) => entry.draftApiNotFound, language);
  assert.equal(failure.message, "Paseo draft API not found. Using plain quotes.");
  assert.equal(describeError(failure, language), "Paseo draft API not found. Using plain quotes.");
  language.set("zh");
  assert.equal(describeError(failure, language), "未找到 Paseo 草稿接口，使用普通引用。");
  assert.equal(describeError(new Error("plain"), language), "plain");
  assert.throws(() => resolveModuleIds("", MODULE_SIGNATURES), (cause) => describeError(cause, language).startsWith("当前 Paseo 的 store 契约不明确"));
  const { binding, input, anchor, dom } = setup();
  language.set("en");
  const plugin = installQuoteComposer({ discover: async () => { throw failure; }, language });
  try {
    await settle();
    language.set("zh");
    const added = await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> a", preview: "a" });
    assert.equal(added.kind, "not-written");
    if (added.kind === "not-written") assert.equal(added.reason, "未找到 Paseo 草稿接口，使用普通引用。");
  } finally { plugin.dispose(); dom.window.close(); }
});

test("side chat errors follow the language", async () => {
  const paseo = { agents: { ref: () => ({ refresh: async () => undefined, current: () => undefined, timeline: { refetch: async () => ({ entries: [] }) } }) } };
  const language = switchableLanguage("en");
  await assert.rejects(startSideChat(paseo as never, { agentId: "a", quote: "q", question: "?", language }), (cause) => describeError(cause, language) === "The main chat is not available.");
  language.set("zh");
  await assert.rejects(startSideChat(paseo as never, { agentId: "a", quote: "q", question: "?", language }), (cause) => describeError(cause, language) === "主对话不可用。");
});

test("the composer chip and preview rows follow a language change", async () => {
  const { host } = await nativeHost();
  const { binding, input, anchor, wrapper, dom } = setup();
  const language = switchableLanguage("zh");
  const plugin = installQuoteComposer({ discover: async () => host, language });
  try {
    await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> one", preview: "one" });
    await plugin.add({ composer: input, anchor, agentId: binding.agentId, formattedText: "> two", preview: "two" });
    await settle();
    const button = wrapper.querySelector("[data-paseo-quote-chip]")?.shadowRoot?.querySelector("button");
    assert.equal(button?.textContent, "2 条注释");
    assert.equal(button?.getAttribute("aria-label"), "查看 2 条注释");
    button?.click();
    const preview = () => dom.window.document.querySelector("[data-paseo-quote-preview]")?.shadowRoot;
    assert.deepEqual([...preview()!.querySelectorAll(".edit")].map((node) => node.textContent), ["编辑", "编辑"]);
    language.set("en");
    await settle();
    assert.equal(button?.textContent, "2 annotations");
    assert.equal(button?.getAttribute("aria-label"), "View 2 annotations");
    assert.deepEqual([...preview()!.querySelectorAll(".edit")].map((node) => node.textContent), ["Edit", "Edit"]);
    assert.deepEqual([...preview()!.querySelectorAll(".remove")].map((node) => node.textContent), ["Remove", "Remove"]);
  } finally {
    plugin.dispose();
    assert.equal(language.listeners(), 0);
    dom.window.close();
  }
});

test("quote source prefix is written per locale and both prefixes parse back", () => {
  for (const [language, prefix] of [[undefined, "Quote source: "], [zh, "引用来源："]] as const) {
    const encoded = encodeExternal(snapshot, sourceUrl, language);
    assert.ok(encoded.text.startsWith(`${prefix}src/a.ts:1-1\n\n`));
    const decoded = decodeExternal({ url: encoded.url, text: encoded.text });
    assert.equal(decoded.kind, "external");
    if (decoded.kind === "external") {
      assert.equal(decoded.snapshot.title, "src/a.ts:1-1");
      assert.equal(decoded.snapshot.text, "const");
    }
  }
});

test("annotation settings messages follow the locale", async () => {
  const values = { chat: false, file: true, diff: true, markdown: true, terminal: true };
  const preferences = createAnnotationPreferences({ rpc: async () => ({ status: "ready", values, revision: "1" }) } as never);
  assert.deepEqual(await preferences.check("chat"), { allowed: false, reason: "Annotations are off for Chat selections. Turn them on in plugin settings." });
  assert.deepEqual(await preferences.check("chat", zh), { allowed: false, reason: "聊天选区注释已关闭，可在插件设置中开启。" });
  preferences.dispose();
});
