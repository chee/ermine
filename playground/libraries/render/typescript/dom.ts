/// <reference lib="dom" />
// @ermine/render/dom: render(into, view, options) makes a view real inside a DOM element,
// reusing what an earlier render put there (@ermine/render: the engine). a prop is a property when
// the element has one (value, checked, className…), else an attribute; a style object is merged
// into style. says: data-ermine-<name> attributes (process, key, source, bind:<prop|text|children>,
// on:<event>, waiting). tells: bubbling events ("ermine:change", "ermine:call", "ermine:called")
import { createRenderer, type Renderer } from "./render.ts"

// a prop: an attribute, or a property when the element has one (value, checked, className…)
function set(el: Element, name: string, value: unknown): string {
	if (name === "class" || name === "className") name = "className"
	if (name === "style" && typeof value === "object" && value !== null) {
		Object.assign((el as HTMLElement).style, value)
		return "prop:style"
	}
	if (name in el && !name.includes("-") && name !== "style") {
		// the same value is not written again: an input keeps its caret
		if ((el as any)[name] !== value) (el as any)[name] = value ?? ""
		return "prop:" + name
	}
	if (value == null || value === false) el.removeAttribute(name)
	else el.setAttribute(name, value === true ? "" : String(value))
	return "attr:" + name
}

function unset(el: Element, what: string) {
	const [how, name] = [what.slice(0, what.indexOf(":")), what.slice(what.indexOf(":") + 1)]
	if (how === "attr") return el.removeAttribute(name)
	try {
		if (name === "style") (el as HTMLElement).style.cssText = ""
		else (el as any)[name] = typeof (el as any)[name] === "boolean" ? false : ""
	} catch { /* a read-only property: left as it is */ }
}

export const dom: Renderer<Node, Element> = {
	element: (tag) => document.createElement(tag),
	text: (s) => document.createTextNode(s),
	setText: (t, s) => {
		if ((t as Text).data !== s) (t as Text).data = s
	},
	parentOf: (n) => n.parentNode as Element | null,
	nextOf: (n) => n.nextSibling,
	insert: (parent, n, before) => void parent.insertBefore(n, before),
	remove: (parent, n) => void parent.removeChild(n),
	set,
	unset,
	listen: (el, type, fn) => el.addEventListener(type, fn as EventListener),
	unlisten: (el, type, fn) => el.removeEventListener(type, fn as EventListener),
	isNode: (x): x is Node => typeof x === "object" && x !== null && "nodeType" in x,
	nameOf: (n) => (n as Element).localName ?? "node",
	say: (el, name, value) => {
		const attr = `data-ermine-${name}`
		if (value === undefined) el.removeAttribute(attr)
		else if (el.getAttribute(attr) !== value) el.setAttribute(attr, value)
	},
	tell: (el, name, detail) =>
		void el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail })),
}

export const { render } = createRenderer(dom)
