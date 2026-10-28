// html for a page with no script (live.ts's /?plain, edge.ts's /?v=plain), from what
// @ermine/render/html renders. LLM generated: a prototype
import { VOID } from "@ermine/render/h"
import { type Element, html, type Kid, quoted } from "@ermine/render/html"

// a unit: an element with a binding and none above it. a page with no script is sent each unit
// again whole when anything in it changes; first, its unit is a <slot> named by the unit's first
// binding (in a declarative shadow root: live.ts), its first render the slot's own content. its
// events are a form's: a button submits form "f" with e = its handler (or the handler of an
// element it is inside, then a space and the button's value); a form posts itself with s = its
// handler; an element with a click handler and no button in it gets an image input, which posts
// where it was clicked, with the element's size from data-ermine-size ("640x220": nothing measures)
export type Plain = {
	// the process the page is: each form's p
	readonly process: string
	// units as slots (the first render), or as they are (one sent again)
	readonly slots: boolean
	// the click handler of an element this is inside
	readonly around?: string
}
// a transparent pixel: the image input's picture
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

export function plain(kid: Kid, at: Plain): string {
	if ("text" in kid) return html(kid)
	const bound = kid.attrs.get("data-ermine-binding")
	if (at.slots && bound) {
		return `<slot name="${quoted(unitName(kid))}">${plain(kid, { ...at, slots: false })}</slot>`
	}
	const attrs = new Map(kid.attrs)
	const click = attrs.get("data-ermine-handler:click")
	const submit = attrs.get("data-ermine-handler:submit")
	let around = at.around
	let first = ""
	let last = ""
	if (kid.tag === "button") {
		const h = click ?? around
		if (h !== undefined) {
			attrs.set("form", "f")
			attrs.set("name", "e")
			attrs.set("value", click ? h : `${h} ${attrs.get("value") ?? ""}`)
			attrs.set("type", "submit")
		}
	} else if (click !== undefined) {
		around = click
		if (!holds(kid, "button")) {
			const [w = "", h = ""] = (attrs.get("data-ermine-size") ?? "").split("x")
			last = `<input type="image" form="f" name="xy ${click} ${w} ${h}" alt="" src="${PIXEL}" ` +
				`class="ermine-where">`
		}
	}
	if (kid.tag === "form" && submit !== undefined) {
		attrs.set("method", "post")
		attrs.set("action", "/event")
		attrs.set("target", "ermine-sink")
		first = `<input type="hidden" name="p" value="${quoted(at.process)}">` +
			`<input type="hidden" name="s" value="${quoted(submit)}">`
	}
	let s = "<" + kid.tag
	for (const [k, v] of attrs) s += v === "" ? ` ${k}` : ` ${k}="${quoted(v)}"`
	if (VOID.has(kid.tag)) return s + ">"
	const kids = kid.kids.map((k) => plain(k, { ...at, around })).join("")
	return `${s}>${first}${kids}${last}</${kid.tag}>`
}

// whether el holds an element of tag
const holds = (el: Element, tag: string): boolean =>
	el.kids.some((k) => "tag" in k && (k.tag === tag || holds(k, tag)))

// a unit's name: its first binding's node
export const unitName = (el: Element): string =>
	(el.attrs.get("data-ermine-binding") ?? "").split(" ")[0]

// each binding under root, to the unit that holds it
export function units(root: Element): Map<string, Element> {
	const out = new Map<string, Element>()
	const walk = (kid: Kid, unit?: Element) => {
		if ("text" in kid) return
		const bound = kid.attrs.get("data-ermine-binding")
		const u = unit ?? (bound ? kid : undefined)
		if (bound && u) { for (const b of bound.split(" ")) out.set(b, u) }
		for (const k of kid.kids) walk(k, u)
	}
	walk(root)
	return out
}
