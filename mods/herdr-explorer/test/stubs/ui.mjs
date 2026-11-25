// Chainable UI stubs for `gpui-kit` and `gpui-base`.
//
// An element answers every builder method (`.flex_1()`, `.child(x)`, `.on_click(fn)`, ...) with
// itself, recording the call, so the real Explorer.render() runs in Node. A test finds a call
// through `records` (or an element's `calls`), reaches its arguments — a virtual list's renderer,
// an `on_item_click` handler — and runs them itself.

/** Every stub call, in order: { tag, name, args, el }. */
export const records = [];

/** Forget every recorded call (a test's beforeEach), including the input context. */
export function resetUi() {
  records.length = 0;
  inputContext = null;
}

/** The calls whose method or function name is `name`, in order. */
export function callsNamed(name) {
  return records.filter(r => r.name === name);
}

/**
 * The element made by the constructor call `name` (e.g. "v_virtual_list"); `test` filters on the
 * constructor's arguments. Null when there is none.
 */
export function findElement(name, test) {
  const hit = records.find(r => r.name === name && r.el && (!test || test(...r.args)));
  return hit?.el ?? null;
}

function record(tag, name, args, el) {
  const entry = { tag, name, args, el };
  records.push(entry);
  el?.calls.push(entry);
  return entry;
}

/**
 * A chainable element with the tag and constructor arguments it was made with. `.child`,
 * `.children` and `.when` keep the tree in `kids` (`.when(cond, fn)` calls `fn(element)` when cond
 * is true, as the real builder does); every other property is a builder method that records and
 * returns this element. `then` is absent, so an element is never mistaken for a promise.
 */
export function makeElement(tag, args = []) {
  const el = { tag, args, calls: [], kids: [] };
  const cache = new Map();
  const proxy = new Proxy(el, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (Object.hasOwn(target, prop)) return target[prop];
      if (prop === "child" || prop === "children" || prop === "when") {
        let fn = cache.get(prop);
        if (!fn) {
          fn = prop === "child" ? child => { record(tag, "child", [child], el); el.kids.push(child); return proxy; }
            : prop === "children" ? list => { record(tag, "children", [list], el); el.kids.push(...list); return proxy; }
              : (cond, fn) => { record(tag, "when", [cond], el); if (cond && typeof fn === "function") fn(proxy); return proxy; };
          cache.set(prop, fn);
        }
        return fn;
      }
      let fn = cache.get(prop);
      if (!fn) {
        fn = (...callArgs) => { record(tag, prop, callArgs, el); return proxy; };
        cache.set(prop, fn);
      }
      return fn;
    },
  });
  return proxy;
}

/** A chainable non-element object: `Popover.new(...)`, an input's `Input.new(input)`. */
function makeBuilder(tag, args) {
  return makeElement(tag, args);
}

// ---- gpui-kit ----

export class View {
  constructor(props) {
    this.props = props;
  }
}

export function div() { const el = makeElement("div", []); record("div", "div", [], el); return el; }
export function svg(path) { const el = makeElement("svg", [path]); record("svg", "svg", [path], el); return el; }
export function image(path) { const el = makeElement("image", [path]); record("image", "image", [path], el); return el; }
export function text(value) { const el = makeElement("text", [value]); record("text", "text", [value], el); return el; }

function listLike(tag) {
  return (...args) => { const el = makeElement(tag, args); record(tag, tag, args, el); return el; };
}

export const list = listLike("list");
export const uniform_list = listLike("uniform_list");

// ---- gpui-base ----

export const h_flex = listLike("h_flex");
export const v_flex = listLike("v_flex");
export const v_virtual_list = listLike("v_virtual_list");
export const h_virtual_list = listLike("h_virtual_list");

/** A place-yourself scrollbar, matched by id with a scroll area (or virtual list). */
export const Scrollbar = {
  new: id => { const el = makeElement("Scrollbar", [id]); record("Scrollbar", "Scrollbar.new", [id], el); return el; },
  horizontal: id => { const el = makeElement("Scrollbar", [id]); record("Scrollbar", "Scrollbar.horizontal", [id], el); return el; },
  vertical: id => { const el = makeElement("Scrollbar", [id]); record("Scrollbar", "Scrollbar.vertical", [id], el); return el; },
};

/** A scroll handle: `scroll_to_item` calls are recorded, and a test may set what layout would. */
export class ScrollHandle {
  static new() {
    const handle = new ScrollHandle();
    handle.calls.push({ name: "new", args: [] });
    return handle;
  }

  constructor() {
    this.calls = [];
    this._offset = { x: 0, y: 0 };
    this._viewport = { width: 0, height: 0 };
    this._content = { width: 0, height: 0 };
  }

  scroll_to_item(index, ...rest) {
    this.calls.push({ name: "scroll_to_item", args: [index, ...rest] });
    this._offset = { x: 0, y: index * 24 };
    return null;
  }

  offset() { return { ...this._offset }; }
  viewport_size() { return { ...this._viewport }; }
  content_size() { return { ...this._content }; }

  /** What a layout pass would report; a test sets it before reading `gw` labels. */
  setViewport(height, width = 400) {
    this._viewport = { width, height };
    this._content = { width, height: Math.max(height, 24) };
    return this;
  }

  setOffset(y) {
    this._offset = { x: 0, y };
    return this;
  }
}

/**
 * A virtual list's scroll handle (gpui-base): `ScrollHandle` plus `scroll_to_bottom`, both of which
 * record their calls. Cursor scrolling and `gw` labels read `offset()`/`viewport_size()`.
 */
export class VirtualListScrollHandle extends ScrollHandle {
  static new() {
    const handle = new VirtualListScrollHandle();
    handle.calls.push({ name: "new", args: [] });
    return handle;
  }

  scroll_to_item(index, strategy = "top") {
    this.calls.push({ name: "scroll_to_item", args: [index, strategy] });
    this._offset = { x: 0, y: index * 24 };
    return null;
  }

  scroll_to_bottom() {
    this.calls.push({ name: "scroll_to_bottom", args: [] });
    return null;
  }

  release() {
    this.calls.push({ name: "release", args: [] });
    this.released = true;
    return true;
  }
}

/** The context a focus or blur handler gets as its second argument; set per test. */
let inputContext = null;

/**
 * Sets the context Herdr delivers to an input's focus and blur handlers, as the host does. A test
 * calls this with the cx it built the view with before it calls `input.focus()` or `blur()`.
 */
export function setInputContext(cx) {
  inputContext = cx;
  return cx;
}

/** A stand-in context for focus and blur when a test has not supplied one. */
function fallbackContext() {
  return { notifications: 0, notify() { this.notifications++; } };
}

/** An input: `value`/`set_value`/`focus`, with its event handlers kept for `fire`. */
export class InputState {
  static new(options = {}) {
    return new InputState(options);
  }

  constructor(options = {}) {
    this.options = options;
    this.fallback = fallbackContext();
    this.handlers = new Map();
    this._value = "";
    this.focused = false;
    this.calls = [];
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return this;
  }

  value() { return this._value; }

  set_value(value) {
    this._value = value;
    this.calls.push({ name: "set_value", args: [value] });
    return this;
  }

  focus() {
    this.focused = true;
    this.calls.push({ name: "focus", args: [] });
    this.fire("focus", {}, this.cx);
    return this;
  }

  blur() {
    this.focused = false;
    this.calls.push({ name: "blur", args: [] });
    this.fire("blur", {}, this.cx);
    return this;
  }

  /** The context focus and blur deliver, read when they fire so a later `setInputContext` applies. */
  get cx() {
    return this.options.cx ?? inputContext ?? this.fallback;
  }

  /** Runs the handlers of `event` with `args`; the host calls them as `(event, cx)`. */
  fire(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
    return this;
  }
}

export const Input = {
  new(input) {
    const el = makeBuilder("Input", [input]);
    el.input = input;
    return el;
  },
};

export const Popover = {
  new(id) { return makeBuilder("Popover", [id]); },
};
