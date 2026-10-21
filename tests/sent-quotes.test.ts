import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, memo, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { JSDOM } from "jsdom";
import { installSentQuotes } from "../client/sent-quotes";
import type { SentNative } from "../client/sent-native";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const quote = (id = "b01259d1-5ecb-4365-a7e7-fb8647c8d52a", text = "> original\n> line 2\n\ncomment\nlast line") => ({
  type: "text", mimeType: "text/plain", text, externalResource: { provider: "quote", resourceType: "quote", id, identifier: `quote-${id}`, title: "选中内容", providerLabel: "引用" },
});
const file = { type: "uploaded_file", fileName: "keep.txt" };
const defaults = { serverId: "host", agentId: "agent", messageId: "message", message: "Keep native body", images: ["image.png"], attachments: [quote(), file], isPending: false };
type Props = Omit<typeof defaults, "attachments"> & { attachments: unknown[] };

function fixture() {
  const dom = new JSDOM('<main style="font-family:Arial;color:rgb(20,20,20);background:rgb(255,255,255)" data-testid="workspace-pane-one"></main><aside></aside>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  Object.assign(globalThis, { document: doc, window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  doc.querySelector<HTMLElement>("main")!.getBoundingClientRect = () => new dom.window.DOMRect(80, 40, 600, 400);
  dom.window.HTMLElement.prototype.getClientRects = function () { const rects = [new dom.window.DOMRect(0, 0, 600, 400)]; return Object.assign(rects, { item: (index: number) => rects[index] ?? null }); };
  let mounts = 0, unmounts = 0, bodyCopied = "", quoteCopied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { quoteCopied = text; } } });
  function Label({ title, subtitle }: { title: string; subtitle: string }) { return h("div", null, h("span", null, title), h("span", null, subtitle)); }
  function Frame({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) {
    return onPress ? h("button", { onClick: onPress }, children) : h("div", { "data-frame": "" }, children);
  }
  const Native = memo(function Native(props: Props) {
    const [opened, open] = useState(false);
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return h("div", { "data-testid": "user-message", "aria-busy": props.isPending }, h("div", null, h("div", null,
      props.images.length ? h("div", null, props.images.map((src) => h(Frame, { key: src, onPress: () => open(!opened) }, h("img", { src, alt: opened ? "opened" : "closed" })))) : null,
      props.attachments.length ? h("div", { "data-tray": "" }, props.attachments.map((attachment, index) => {
        const data = attachment as ReturnType<typeof quote>;
        return h(Frame, { key: index }, h(Label, data.type === "text" && data.externalResource ? { title: data.externalResource.title, subtitle: `${data.externalResource.providerLabel} ${data.externalResource.identifier}` } : { title: "keep.txt", subtitle: "Text file" }));
      })) : null,
      props.message.trim() ? h("span", { "data-message-text": "true" }, props.message) : null),
      props.message.trim() ? h("div", { "data-testid": "user-message-trailing-row" }, h("button", { "data-copy": "", onClick: () => { bodyCopied = props.message; } }, "Copy")) : null));
  });
  const root = createRoot(doc.querySelector("main")!);
  const capability: SentNative = { user: Native, frame: Frame, label: Label };
  return { dom, doc, Native, capability, counts: () => ({ mounts, unmounts }), copied: () => ({ bodyCopied, quoteCopied }),
    async render(props: Props = defaults, portal = false) {
      const content = h("div", { "data-message-id": "row-stream-id", style: { display: "flex", flexDirection: "column" } }, h(Native, props));
      await act(async () => root.render(portal ? createPortal(content, doc.querySelector("aside")!) : content)); await tick();
    },
    install(discover: (signal: AbortSignal) => Promise<SentNative> = async () => capability) { return installSentQuotes({ discover }); },
    native: () => doc.querySelector<HTMLElement>('[data-testid="user-message"]')!,
    capsule: () => doc.querySelector<HTMLElement>('[data-paseo-sent-quotes="capsule"]'),
    async clear() { await act(async () => root.render(null)); await tick(); },
    async close() { await act(async () => root.unmount()); dom.window.close(); },
  };
}
function controls(f: ReturnType<typeof fixture>) {
  const element = f.capsule(); assert.ok(element);
  const button = element.shadowRoot!.querySelector<HTMLButtonElement>(".chip")!;
  const shadow = f.doc.querySelector<HTMLElement>('[data-paseo-sent-quotes="popup"]')!.shadowRoot!, panel = shadow.querySelector<HTMLElement>(".panel")!;
  return { element, shadow, button, panel };
}

for (const provider of ["quote", "quote-notes"]) {
  test(`${provider} mixed sent row keeps React state, native media/file/body/copy and token footer while exposing exact complete text`, async () => {
    const attachment = { ...quote(), externalResource: { ...quote().externalResource, provider } };
    const props = { ...defaults, attachments: [attachment, file] };
    const f = fixture(); await f.render(props);
    const native = f.native(), image = native.querySelector("img")!, frames = [...native.querySelectorAll<HTMLElement>("[data-frame]")];
    await act(async () => image.parentElement!.click());
    const footer = f.doc.createElement("div"); footer.textContent = "token footer"; native.after(footer);
    let dispose = f.install();
    try {
      await tick();
      const { element, shadow, button, panel } = controls(f);
      assert.equal(button.textContent, "1 annotation");
      assert.equal(element.nextSibling, native); assert.equal(native.nextSibling, footer);
      assert.equal(f.doc.querySelector('[data-paseo-sent-quotes="popup"]')!.parentElement, f.doc.body);
      assert.equal(native.style.display, ""); assert.equal(frames[0].style.display, "none"); assert.equal(frames[1].style.display, "");
      assert.equal(f.native(), native); assert.equal(native.querySelector("img"), image); assert.equal(image.alt, "opened");
      native.querySelector<HTMLButtonElement>("[data-copy]")!.click(); assert.equal(f.copied().bodyCopied, defaults.message);
      button.click(); assert.equal(panel.hidden, false); assert.equal(shadow.querySelector("pre")!.textContent, quote().text);
      shadow.querySelector<HTMLButtonElement>(".copy")!.click(); await tick(); assert.equal(f.copied().quoteCopied, quote().text);
      await f.render({ ...props }); assert.equal(f.capsule(), element); assert.equal(panel.hidden, false);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      assert.equal(f.capsule(), element); assert.equal(native.nextSibling, footer);
      assert.deepEqual(f.counts(), { mounts: 1, unmounts: 0 });
      dispose(); dispose(); assert.equal(f.capsule(), null); assert.equal(frames[0].style.display, ""); assert.equal(native.nextSibling, footer);
      dispose = f.install(); await tick(); assert.ok(f.capsule());
    } finally { dispose(); await f.close(); }
  });
}

test("quote-only rows hide empty native shell reversibly, and numbered disclosure supports keyboard/outside and bounds", async () => {
  const f = fixture(); const second = quote("1f285941-27b0-45bc-89a8-8a4acc9fd050", "second\n\nfull content");
  await f.render({ ...defaults, message: "", images: [], attachments: [quote(), second] });
  const native = f.native(); native.style.display = "flex";
  const dispose = f.install();
  try {
    await tick(); const { element, shadow, button, panel } = controls(f);
    assert.equal(native.style.display, "none"); assert.equal(button.textContent, "2 annotations");
    button.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    assert.equal(panel.hidden, false); assert.equal(shadow.activeElement, panel); assert.equal(panel.tabIndex, -1); assert.deepEqual([...shadow.querySelectorAll("pre")].map((pre) => pre.textContent), [quote().text, second.text]);
    assert.match(shadow.querySelectorAll(".entry-head")[1].textContent!, /^2\. /);
    assert.equal(panel.style.width, "360px");
    assert.ok(Number.parseFloat(panel.style.left) >= 80);
    assert.ok(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width) <= 680);
    assert.equal(panel.style.maxHeight, "400px");
    panel.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
    assert.equal(panel.hidden, true); assert.equal(element.shadowRoot!.activeElement, button);
    button.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true, cancelable: true })); assert.equal(panel.hidden, false);
    f.doc.body.dispatchEvent(new f.dom.window.Event("pointerdown", { bubbles: true })); assert.equal(panel.hidden, true);
    await new Promise((resolve) => setTimeout(resolve, 1050)); assert.equal(f.capsule(), element);
  } finally { dispose(); assert.equal(native.style.display, "flex"); await f.close(); }
});

test("props-only identity/content changes reset disclosure without replacing the native row", async () => {
  const f = fixture(); await f.render(); const native = f.native(); const dispose = f.install();
  try {
    await tick(); const old = controls(f); old.button.click();
    await f.render({ ...defaults, serverId: "another-host", messageId: "new-message" });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(f.native(), native); assert.notEqual(f.capsule(), old.element); assert.equal(controls(f).panel.hidden, true);
    const current = controls(f); current.button.click();
    await f.render({ ...defaults, attachments: [quote(undefined, "changed text with same native label"), file] });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.notEqual(f.capsule(), current.element); assert.equal(controls(f).panel.hidden, true);
    assert.equal(controls(f).shadow.querySelector("pre")!.textContent, "changed text with same native label");
  } finally { dispose(); await f.close(); }
});

for (const reason of ["metadata", "mime", "id", "order", "count", "label", "hidden", "hidden-fiber", "portal", "slot", "stale", "alternate", "ambiguous"] as const) {
  test(`unproven ${reason} row stays native`, async () => {
    const f = fixture(); let props: Props = defaults;
    if (reason === "metadata") props = { ...defaults, attachments: [{ ...quote(), externalResource: { ...quote().externalResource, provider: "other" } }, file] };
    if (reason === "mime") props = { ...defaults, attachments: [{ ...quote(), mimeType: "text/markdown" }, file] };
    if (reason === "id") props = { ...defaults, attachments: [{ ...quote(), externalResource: { ...quote().externalResource, identifier: "quote-wrong" } }, file] };
    await f.render(props, reason === "portal"); const native = f.native(), tray = native.querySelector<HTMLElement>("[data-tray]")!;
    if (reason === "order") tray.prepend(tray.lastElementChild!);
    if (reason === "count") tray.append(f.doc.createElement("div"));
    if (reason === "label") tray.firstElementChild!.textContent = "lookalike";
    if (reason === "hidden") native.parentElement!.style.display = "none";
    if (reason === "slot") native.parentElement!.style.flexDirection = "column-reverse";
    if (reason === "stale") for (const key of Object.keys(native).filter((key) => key.startsWith("__reactFiber$"))) Reflect.set(native, key, {});
    let restoreRoot = () => {};
    if (reason === "hidden-fiber") {
      const key = Object.keys(native).find((key) => key.startsWith("__reactFiber$"))!;
      const host = Reflect.get(native, key);
      let owner = host; while (owner.elementType !== f.Native && owner.return) owner = owner.return;
      const previousTag = owner.tag, previousState = owner.memoizedState;
      owner.tag = 22; owner.memoizedState = {};
      restoreRoot = () => { owner.tag = previousTag; owner.memoizedState = previousState; };
    }
    if (reason === "alternate") {
      for (const key of Object.keys(native).filter((key) => key.startsWith("__reactFiber$"))) {
        const current = Reflect.get(native, key); let node = current; while (node.return) node = node.return;
        const original = node.stateNode.current;
        const forged = { ...node, child: null }; node.stateNode.current = forged;
        restoreRoot = () => { node.stateNode.current = original; };
      }
    }
    if (reason === "ambiguous") native.parentElement!.append(native.cloneNode(true));
    const dispose = f.install();
    try { await tick(); assert.equal(f.capsule(), null); assert.equal(tray.firstElementChild!.getAttribute("style"), null); }
    finally { dispose(); restoreRoot(); await f.close(); }
  });
}

test("native controls prevent quote-only shell hiding and newer foreign display styles survive cleanup", async () => {
  const f = fixture(); await f.render({ ...defaults, message: "", images: [], attachments: [quote()] });
  const native = f.native(), control = f.doc.createElement("button"); native.append(control);
  const frame = native.querySelector<HTMLElement>("[data-frame]")!;
  const dispose = f.install();
  try {
    await tick(); assert.ok(f.capsule()); assert.equal(native.style.display, "");
    frame.style.setProperty("display", "grid", "important"); await tick();
    assert.equal(frame.style.display, "grid"); assert.equal(f.capsule(), null);
    await tick(); assert.equal(frame.style.display, "grid"); assert.equal(f.capsule(), null);
  } finally { dispose(); assert.equal(frame.style.display, "grid"); control.remove(); await f.close(); }
});

test("disconnect and async disposal remove only owned nodes and abort discovery", async () => {
  const f = fixture(); await f.render(); let aborted = false;
  let finish: (native: SentNative) => void = () => {};
  const disposePending = f.install((signal) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise((resolve) => { finish = resolve; }); });
  disposePending(); finish(f.capability); await tick(); assert.equal(aborted, true); assert.equal(f.capsule(), null);
  const dispose = f.install();
  try {
    await tick(); const native = f.native(), capsule = f.capsule()!;
    await f.clear(); assert.equal(capsule.isConnected, false);
    assert.equal(native.querySelector<HTMLElement>("[data-frame]")!.style.display, "");
  } finally { dispose(); await f.close(); }
});

for (const failure of ["unavailable", "denied"] as const) {
  test(`copy ${failure} leaves complete selectable sent text and reports the outcome`, async () => {
    const f = fixture(); await f.render();
    Object.defineProperty(f.dom.window.navigator, "clipboard", { configurable: true, value: failure === "unavailable" ? undefined : { writeText: async () => { throw new Error("denied"); } } });
    const dispose = f.install();
    try {
      await tick(); const { shadow, button } = controls(f); button.click();
      const copy = shadow.querySelector<HTMLButtonElement>(".copy")!; copy.click(); await tick();
      assert.equal(copy.textContent, failure === "unavailable" ? "Select the text to copy" : "Copy failed");
      assert.equal(shadow.querySelector("pre")!.textContent, quote().text);
    } finally { dispose(); await f.close(); }
  });
}

test("foreign hiding marker transfer relinquishes the frame without restoring or rehiding foreign styles", async () => {
  const f = fixture(); await f.render(); const dispose = f.install();
  try {
    await tick(); const frame = f.native().querySelector<HTMLElement>("[data-frame]")!;
    frame.setAttribute("data-paseo-sent-quote-hidden", "another-owner"); await tick();
    assert.equal(f.capsule(), null); assert.equal(frame.getAttribute("data-paseo-sent-quote-hidden"), "another-owner");
    assert.equal(frame.style.getPropertyValue("display"), "none");
    frame.style.display = "block"; await tick(); assert.equal(frame.style.display, "block");
  } finally { dispose(); await f.close(); }
});

test("unsupported native discovery reports one safe warning while preserving native cards", async () => {
  const f = fixture(); await f.render(); const warnings: unknown[][] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const dispose = f.install(async () => { throw new Error("private runtime detail"); });
  try {
    await tick(); assert.equal(f.capsule(), null); assert.deepEqual(warnings, [["The quote plugin could not confirm the native message component. Native attachments are kept."]]);
    assert.equal(f.native().querySelector<HTMLElement>("[data-frame]")!.style.display, "");
  } finally { dispose(); console.warn = warn; await f.close(); }
});

for (const kind of ["mixed", "quote-only"] as const) {
  test(`${kind} sent capsule and popup read native label text colors and font independently of the flex slot`, async () => {
    const f = fixture(); await f.render(kind === "mixed" ? defaults : { ...defaults, message: "", images: [], attachments: [quote()] });
    const native = f.native(), slot = native.parentElement!, title = native.querySelector<HTMLElement>("[data-frame] span")!;
    Object.assign(slot.style, { color: "rgb(0, 0, 0)", fontFamily: "SlotFont", backgroundColor: "rgb(24, 24, 27)" });
    Object.assign(title.style, { color: "rgb(230, 231, 232)", fontFamily: "NativeMessageFont" });
    assert.equal(f.dom.window.getComputedStyle(slot).color, "rgb(0, 0, 0)");
    assert.equal(f.dom.window.getComputedStyle(title).color, "rgb(230, 231, 232)");
    const dispose = f.install();
    try {
      await tick();
      const { element } = controls(f), popup = f.doc.querySelector<HTMLElement>('[data-paseo-sent-quotes="popup"]')!;
      for (const host of [element, popup]) {
        assert.equal(host.style.getPropertyValue("--quote-fg"), "rgb(230, 231, 232)");
        assert.equal(host.style.getPropertyValue("--quote-font"), "NativeMessageFont");
        assert.equal(host.style.getPropertyValue("--quote-bg"), "rgb(24, 24, 27)");
      }
      title.style.color = "rgb(210, 211, 212)"; await tick();
      assert.equal(f.capsule(), element);
      assert.equal(element.style.getPropertyValue("--quote-fg"), "rgb(210, 211, 212)");
      assert.equal(popup.style.getPropertyValue("--quote-fg"), "rgb(210, 211, 212)");
    } finally { dispose(); await f.close(); }
  });
}

test("the sent chip, header and copy button follow a language change", async () => {
  const f = fixture(); await f.render();
  let locale: "en" | "zh" = "zh"; const listeners = new Set<() => void>();
  const language = { getSnapshot: () => locale, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const dispose = installSentQuotes({ discover: async () => f.capability, language });
  try {
    await tick(); const { button, shadow, panel } = controls(f);
    assert.equal(button.textContent, "1 条注释"); assert.equal(shadow.querySelector("header")!.textContent, "注释");
    assert.equal(shadow.querySelector(".copy")!.textContent, "复制全文"); assert.equal(panel.getAttribute("aria-label"), "已发送的注释");
    locale = "en"; for (const listener of listeners) listener();
    assert.equal(button.textContent, "1 annotation"); assert.equal(shadow.querySelector("header")!.textContent, "Annotations");
    assert.equal(shadow.querySelector(".copy")!.textContent, "Copy full text"); assert.equal(panel.getAttribute("aria-label"), "Sent annotations");
  } finally { dispose(); assert.equal(listeners.size, 0); await f.close(); }
});
