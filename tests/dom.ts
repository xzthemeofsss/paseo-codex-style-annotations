import { JSDOM } from "jsdom";
import { bindComposer, installationOwnerSchema } from "../client/host-draft-bridge";

export const fixtureOwner = installationOwnerSchema.parse({ hostId: "fixture-host" });

export function setup() {
  const dom = new JSDOM(`<html><head></head><body><div data-testid="workspace-pane-one"><div data-testid="workspace-tab-agent_agent-one" aria-selected="true"></div><div data-testid="agent-chat-scroll"><p id="selection">原始引用内容</p></div><div data-testid="message-input-root"><div id="presentation"><div id="wrapper" style="display:flex;flex-direction:column;border:1px solid #444;border-radius:12px;background:rgb(255,255,255)"><textarea data-composer-input></textarea></div></div></div></div></body></html>`, { pretendToBeVisual: true, url: "https://app.paseo.test/h/fixture-host/workspace/workspace-one" });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLButtonElement: window.HTMLButtonElement, MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window) });
  window.document.querySelector<HTMLElement>('[data-testid="workspace-pane-one"]')!.getBoundingClientRect = () => new window.DOMRect(0, 0, window.innerWidth, window.innerHeight);
  Object.defineProperty(window.HTMLElement.prototype, "isContentEditable", { get() { return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true"; } });
  window.HTMLElement.prototype.getClientRects = function () {
    const values = [{ left: 10, top: 10, bottom: 40, right: 100, width: 90, height: 30, x: 10, y: 10, toJSON: () => ({}) }];
    return Object.assign(values, { item: (index: number) => values[index] ?? null });
  };
  const input = window.document.querySelector("textarea");
  const anchor = window.document.querySelector("#selection");
  const wrapper = window.document.querySelector("#wrapper");
  if (!(input instanceof window.HTMLTextAreaElement) || !(anchor instanceof window.HTMLElement) || !(wrapper instanceof window.HTMLElement)) throw new Error("Fixture DOM is missing");
  const binding = bindComposer(input, anchor, "agent-one");
  if (!binding) throw new Error("Fixture composer was not bound");
  return { dom, input, anchor, wrapper, binding };
}
export const settle = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

