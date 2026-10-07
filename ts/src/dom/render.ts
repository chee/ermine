/// <reference lib="dom" />
// The renderer: h, jsx and render, in @shift/dom's shape. JSX makes real DOM
// at once. A child or an attribute value that is a handle, or a function of
// no arguments (an accessor), is bound: it is a scope the scheduler runs
// (track.ts; ts/demo/dom.org, Scopes), whose compute reads it and whose effect
// patches only that part of the DOM: a text node's data, an attribute.
// Everything else is static. Components run once, untracked, as in Solid and
// @shift/dom. JSX made inside a scope's compute is that scope's: its bound
// parts are its children, disposed when it runs again.
//
// A handle as a child renders its items, in order: the items a scheduler
// puts in front of a process's value as small marks (waiting, stopped,
// error, newer), then each member's value as text, a pending member as a
// pending mark. So a handle on a slot of one member is its value, and one on
// a union is a list. A value that is a DOM node, as an ephemeral node's live
// value may be, is put in as it is.
//
// Every DOM node a bound part made is remembered with the scope that made
// it, and the item it shows, so why.ts can lead from a click back to the
// graph, through the scope's record.

import { isBytes, isLive, kindOf } from "../patch.ts";
import type { MakeScope } from "../loaders.ts";
import { type Item, type Json, ours, type SlotItem } from "../types.ts";
import { type Handle, isHandle } from "./handle.ts";
import { owned, owner, type Scope, scope, untracked } from "./track.ts";

ours(import.meta.url);

/** What JSX evaluates to, and what may be a child. */
export type Child =
  | Node
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Handle
  | (() => Child)
  | Child[];

export type Component<P = Record<string, unknown>> = (props: P) => Child;

// deno-lint-ignore no-explicit-any
type Props = Record<string, any>;

/** A bound part's scope, once made: its first effect runs before the maker has it. */
export type Ref = { scope?: Scope };

/** A DOM node a bound part made: the scope that made it, and the item it shows, if one. */
export type Binding = { ref: Ref; item?: Item };

/** Each node a bound part made. */
export const bound = new WeakMap<Node, Binding>();
/** Each element a bound part was put in, or whose attribute is bound: the scopes. */
export const holds = new WeakMap<Node, Ref[]>();
/** Text nodes this renderer made, which it may write into again. */
const ours_ = new WeakSet<Node>();

let doc: Document | undefined;
const document_ = (): Document => {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) throw new Error("no document: render into an element, or set globalThis.document");
  return d;
};

const SVG = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan",
  "defs",
  "use",
  "symbol",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "foreignObject",
]);

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).nodeType === "number";

/** A nullary function is an accessor; one that takes arguments is a value, such as a callback. */
const isAccessor = (v: unknown): v is () => Child =>
  isHandle(v) || (typeof v === "function" && v.length === 0);

// elements

/** h(type, props, ...children), the classic JSX factory. */
export function h(
  type: string | Component<Props>,
  props?: Props | null,
  ...children: Child[]
): Child {
  const p: Props = { ...(props ?? {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return make(type, p);
}

/** jsx(type, props, key), the automatic JSX runtime's. */
export function jsx(type: string | Component<Props>, props: Props, _key?: unknown): Child {
  return make(type, props ?? {});
}
export const jsxs = jsx;

export function Fragment(props: { children?: Child }): Child {
  return props.children ?? null;
}

function make(type: string | Component<Props>, props: Props): Child {
  if (typeof type === "function") return untracked(() => type(props));
  const d = document_();
  const el = SVG_TAGS.has(type) ? d.createElementNS(SVG, type) : d.createElement(type);
  for (const key in props) {
    if (key === "children" || key === "key") continue;
    prop(el, key, props[key]);
  }
  if (props.children != null) insert(el, props.children);
  return el;
}

function prop(el: Element, key: string, value: unknown) {
  if (key === "ref") {
    if (typeof value === "function") value(el);
    return;
  }
  if (key.length > 2 && key.startsWith("on") && typeof value === "function" && !isHandle(value)) {
    // a handler: called as the DOM calls it, untracked, under the owner it was made under, so
    // JSX it makes has one; what it writes is written from its line
    const type = key.slice(2).toLowerCase();
    const make = owner();
    const f = value as (e: Event) => unknown;
    el.addEventListener(type, (e) => {
      const call = () => untracked(() => f(e));
      return make ? owned(make, call) : call();
    });
    return;
  }
  if (isAccessor(value)) {
    const ref: Ref = {};
    ref.scope = scope(() => resolve(value), (v) => apply(el, key, v));
    hold(el, ref);
    return;
  }
  apply(el, key, value);
}

/** Reads an accessor, or a handle, down to a plain value. */
function resolve(v: unknown): unknown {
  while (isAccessor(v)) v = isHandle(v) ? v() : v();
  return v;
}

/** Sets a property where the element has a matching one it can take, else an attribute. */
export function apply(el: Element, key: string, value: unknown) {
  switch (key) {
    case "class":
    case "className":
      return attr(el, "class", Array.isArray(value) ? value.filter(Boolean).join(" ") : value);
    case "style":
      if (value !== null && typeof value === "object") {
        const css = Object.entries(value).filter(([, v]) => v != null)
          .map(([k, v]) => `${k}: ${v}`).join("; ");
        return attr(el, "style", css || null);
      }
      return attr(el, "style", value);
    case "value":
    case "checked": {
      // a property, set only when it differs, so a caret is not moved under someone typing
      const want = key === "value" ? String(value ?? "") : !!value;
      // deno-lint-ignore no-explicit-any
      if ((el as any)[key] !== want) (el as any)[key] = want;
      return;
    }
  }
  attr(el, key, value);
}

function attr(el: Element, key: string, value: unknown) {
  if (value == null || value === false) el.removeAttribute(key);
  else el.setAttribute(key, value === true ? "" : String(value));
}

function hold(el: Node, ref: Ref) {
  const list = holds.get(el);
  if (list) list.push(ref);
  else holds.set(el, [ref]);
}

// children

/** One piece of DOM a child makes: text, or a node, and the item it shows. */
type Part = { text: string; item?: Item } | { node: Node; item?: Item };

/**
 * Puts a child into parent before anchor: static parts once, a bound part as
 * a scope of its own, whose compute makes its parts and whose effect puts
 * them in place before its mark.
 */
export function insert(parent: Node, value: Child, anchor: Node | null = null) {
  if (Array.isArray(value)) {
    for (const c of value) insert(parent, c, anchor);
    return;
  }
  if (!isAccessor(value)) {
    for (const p of parts(value)) parent.insertBefore(nodeOf(p), anchor);
    return;
  }
  const mark = document_().createTextNode("");
  parent.insertBefore(mark, anchor);
  let current: Node[] = [];
  const ref: Ref = {};
  ref.scope = scope(() => parts(value), (next) => {
    // the mark moves with what it was put in: a fragment's, into the container
    current = reconcile(mark.parentNode ?? parent, current, next, mark);
    next.forEach((p, i) => bound.set(current[i], { ref, ...(p.item ? { item: p.item } : {}) }));
  });
  hold(parent, ref);
}

/** The parts a child makes now, reading what it binds. */
function parts(value: Child): Part[] {
  if (value == null || value === false || value === true || value === "") return [];
  if (isHandle(value)) return handleParts(value);
  if (typeof value === "function") return parts(value());
  if (Array.isArray(value)) return value.flatMap(parts);
  if (isNode(value)) return [{ node: value }];
  return [{ text: String(value) }];
}

/** A handle's items, in order: marks for the items in front, each member's value, pending members. */
function handleParts(h: Handle): Part[] {
  const slot = h.slot();
  const items = h.items();
  const out: Part[] = [];
  const values: Item[] = [];
  for (const item of items) {
    if (Object.hasOwn(item, "value")) values.push(item);
    else out.push({ node: mark(item), item });
  }
  const member = (i: Item) =>
    "from" in i && "route" in i.from ? i.from.route.at(-1)?.node : undefined;
  if (!slot.length) {
    for (const v of values) out.push(valuePart(v));
    return out;
  }
  for (const s of slot) {
    if (s.pending) {
      out.push({ node: mark(s), item: s });
      continue;
    }
    for (const v of values) if (member(v) === s.id) out.push(valuePart(v));
  }
  return out;
}

function valuePart(item: Item): Part {
  const value = (item as { value: Json }).value;
  if (isNode(value)) return { node: value, item };
  return { text: text(value), item };
}

/** A value as text for people. */
export function text(value: Json | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isBytes(value)) return `${value.byteLength} bytes`;
  const kind = kindOf(value);
  if (kind) return `${kind} × ${(value as ArrayLike<number>).length}`;
  if (isLive(value)) return "(live)";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The mark for an item that is not a value: a scheduler's item in front of a
 * process's value, or a pending member. A span with a class, so a page can
 * style it; its title says more.
 */
function mark(item: Item | SlotItem): Node {
  const el = document_().createElement("span");
  const i = item as { [k: string]: unknown };
  let kind: string, sign: string, title: string;
  if ("waiting" in i) {
    kind = "waiting",
      sign = "…",
      title = `waiting on changes ${(i.waiting as number[]).join(", ")}`;
  } else if ("stopped" in i) kind = "stopped", sign = "■", title = "stopped";
  else if ("error" in i) {
    const why = (i.error as { why?: { code?: string; text?: string; message?: string } }).why ?? {};
    kind = "error", sign = `✕ ${why.code ?? "error"}`;
    title = why.text ?? why.message ?? why.code ?? "error";
  } else if ("newer" in i) kind = "newer", sign = "↑", title = "a newer program is there";
  else if ("pending" in i) kind = "pending", sign = "…", title = `${i.id} is not here yet`;
  else if ("refused" in i) kind = "refused", sign = "⊘", title = "refused";
  else kind = "item", sign = "?", title = JSON.stringify(item);
  el.setAttribute("class", `ermine-${kind}`);
  el.setAttribute("title", title);
  el.textContent = sign;
  return el;
}

function nodeOf(p: Part): Node {
  if ("node" in p) return p.node;
  const t = document_().createTextNode(p.text);
  ours_.add(t);
  return t;
}

/**
 * Puts next in place of current before anchor. A text part reuses the text
 * node in its place, writing its data only when it differs, so a change of
 * value is one write to one text node.
 */
function reconcile(parent: Node, current: Node[], next: Part[], anchor: Node): Node[] {
  const nodes: Node[] = next.map((p, i) => {
    const old = current[i];
    if ("text" in p && old && ours_.has(old)) {
      if ((old as Text).data !== p.text) (old as Text).data = p.text;
      return old;
    }
    return nodeOf(p);
  });
  const keep = new Set(nodes);
  for (const n of current) if (!keep.has(n) && n.parentNode === parent) parent.removeChild(n);
  let before: Node = anchor;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.parentNode !== parent || n.nextSibling !== before) parent.insertBefore(n, before);
    before = n;
  }
  return nodes;
}

/**
 * Renders what code makes into container, as a scope owned by ctx's process
 * (an effect's ctx), or by the scope being computed now: code runs once,
 * untracked, and each bound part in it is a scope under that one. Gives back
 * the scope; calling it undoes the render: every scope disposed, so the
 * graph forgets their reads, and every node it put in taken out, nothing else.
 * A kill does the same.
 */
export function render(code: () => Child, container: Node, ctx?: { scope?: MakeScope }): Scope {
  doc = container.ownerDocument ?? (container as Document);
  const make = ctx?.scope ?? owner();
  if (!make) {
    throw new Error("render needs an owner: an effect's ctx, render(fn, el, ctx), or show");
  }
  return owned(make, () =>
    scope(
      () =>
        untracked(() => {
          const frag = document_().createDocumentFragment();
          insert(frag, code());
          return frag;
        }),
      (frag) => {
        // between two marks: what it put in, and what its parts put in later, and nothing else
        const start = document_().createTextNode(""), end = document_().createTextNode("");
        frag.insertBefore(start, frag.firstChild);
        frag.appendChild(end);
        container.appendChild(frag);
        return () => {
          const parent = start.parentNode;
          if (!parent) return;
          for (let n: Node | null = start; n;) {
            const next: Node | null = n === end ? null : n.nextSibling;
            parent.removeChild(n);
            n = next;
          }
        };
      },
    ));
}

/**
 * A handle's directory as a list: fn makes a row for each name, with a
 * handle on it. When a name comes or goes, the rows are made again; a row's
 * own bound parts update by themselves.
 */
export function each(h: Handle, fn: (child: Handle, name: string) => Child): () => Child {
  return () => h.names().map((name) => untracked(() => fn(h.at(name), name)));
}
