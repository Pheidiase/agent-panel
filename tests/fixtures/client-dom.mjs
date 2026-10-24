// Small DOM surface for mounting real React roots without a browser or sockets.
// Layout/painting are intentionally outside this fixture's scope.
export function clientDom() {
  const previous = new Map();
  class Node {
    constructor(type, name, doc) {
      this.nodeType = type; this.nodeName = name; this.ownerDocument = doc;
      this.parentNode = null; this.childNodes = []; this.listeners = new Map();
    }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, before) {
      node.parentNode?.removeChild(node);
      const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
    }
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes.at(-1) ?? null; }
    get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(""); }
    set textContent(value) {
      if (this.nodeType === 3) { this.nodeValue = String(value); return; }
      for (const node of this.childNodes) node.parentNode = null;
      this.childNodes = [];
      if (value !== "") this.appendChild(this.ownerDocument.createTextNode(value));
    }
    contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    dispatchEvent(event) {
      event.target = this;
      event.preventDefault = () => { event.defaultPrevented = true; };
      event.stopPropagation = () => { event.stopped = true; };
      for (let node = this; node && !event.stopped; node = node.parentNode)
        for (const listener of node.listeners.get(event.type) ?? []) listener(event);
      return !event.defaultPrevented;
    }
  }
  class Element extends Node {
    constructor(name, doc, namespace = "http://www.w3.org/1999/xhtml") {
      super(1, name.toUpperCase(), doc);
      this.tagName = this.nodeName; this.namespaceURI = namespace; this.attributes = new Map();
      this.style = { setProperty(name, value) { this[name] = value; } }; this.open = false;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    removeAttributeNS(_namespace, name) { this.removeAttribute(name); }
    get className() { return this.getAttribute("class") ?? ""; }
    set className(value) { this.setAttribute("class", value); }
    focus() { this.ownerDocument.activeElement = this; }
    getBoundingClientRect() { return { height: 96, top: 0, left: 0, width: 500 }; }
    querySelectorAll(selector) {
      return this.childNodes.flatMap(node => node.nodeType === 1
        ? [...(node.tagName.toLowerCase() === selector ? [node] : []), ...node.querySelectorAll(selector)] : []);
    }
  }
  const document = new Node(9, "#document", null);
  document.ownerDocument = document;
  document.createElement = name => new Element(name, document);
  document.createElementNS = (ns, name) => new Element(name, document, ns);
  document.createTextNode = value => Object.assign(new Node(3, "#text", document), { nodeValue: String(value) });
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  document.appendChild(document.documentElement); document.documentElement.appendChild(document.body);
  document.activeElement = document.body;
  const window = { document, HTMLElement: Element, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} };
  document.defaultView = window;
  for (const [name, value] of Object.entries({ document, window, HTMLElement: Element, HTMLDetailsElement: Element, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = document.createElement("div"); document.body.appendChild(container);
  return { document, container, restore() {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  } };
}
