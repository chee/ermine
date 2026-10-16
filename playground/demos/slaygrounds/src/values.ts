/// <reference lib="dom" />
// values as the console shows them: real, expandable, lazily. the values live in the program's
// iframe (another realm: instanceof fails there, so kinds are told by their tag)

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

const tagOf = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1)
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const key = (k: string | symbol) =>
	typeof k === "symbol" ? `[${String(k)}]` : /^[\w$]+$/.test(k) ? k : JSON.stringify(k)
const isObject = (v: unknown): v is object =>
	(typeof v === "object" && v !== null) || typeof v === "function"

function get(o: object, k: string | symbol): unknown {
	try {
		return (o as Record<string | symbol, unknown>)[k]
	} catch (e) {
		return e
	}
}

// the name of what made it: Foo for a class instance, nothing for a plain object
function ctor(v: object) {
	try {
		const name = (v as { constructor?: { name?: string } }).constructor?.name
		return name && name !== "Object" ? name : ""
	} catch {
		return ""
	}
}

// one line, to a depth
export function preview(v: unknown, depth = 0): string {
	switch (typeof v) {
		case "string":
			return depth || true ? JSON.stringify(cut(v, 60)) : v
		case "symbol":
			return String(v)
		case "bigint":
			return v + "n"
		case "undefined":
			return "undefined"
		case "function": {
			const src = Function.prototype.toString.call(v)
			const arrow = /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.exec(src)
			return /^class\b/.test(src)
				? `class ${(v as { name: string }).name}`
				: `ƒ ${(v as { name: string }).name || ""}${
					arrow ? arrow[2] : /\([^)]*\)/.exec(src)?.[0] ?? "()"
				}`
		}
	}
	if (v === null || typeof v !== "object") return String(v)
	const tag = tagOf(v)
	const inner = (x: unknown) => (depth >= 2 ? "…" : preview(x, depth + 1))
	const list = (items: unknown[], total: number) =>
		items.slice(0, 5).map(inner).join(", ") + (total > 5 ? ", …" : "")
	if (Array.isArray(v)) return `Array(${v.length}) [${list(v, v.length)}]`
	if (ArrayBuffer.isView(v)) {
		const a = Array.from(v as unknown as ArrayLike<number>)
		return `${tag}(${a.length}) [${list(a, a.length)}]`
	}
	if (tag === "Map") {
		const m = v as Map<unknown, unknown>
		const items = [...m].slice(0, 5).map(([a, b]) => `${inner(a)} => ${inner(b)}`)
		return `Map(${m.size}) {${items.join(", ")}${m.size > 5 ? ", …" : ""}}`
	}
	if (tag === "Set") {
		return `Set(${(v as Set<unknown>).size}) {${
			list([...(v as Set<unknown>)], (v as Set<unknown>).size)
		}}`
	}
	if (tag === "Date") {
		return String(isNaN(+(v as Date)) ? "Invalid Date" : (v as Date).toISOString())
	}
	if (tag === "RegExp") return String(v)
	if (tag === "Promise") return "Promise {…}"
	if (tag === "Error" || v instanceof Error) {
		const e = v as Error
		return `${e.name}: ${cut(e.message, 80)}`
	}
	if ("nodeType" in v && typeof (v as Node).nodeType === "number") {
		return `<${((v as Element).localName ?? (v as Node).nodeName).toLowerCase()}>`
	}
	const keys = Reflect.ownKeys(v)
	const shown = keys.slice(0, 4).map((k) => `${key(k)}: ${inner(get(v, k))}`)
	const name = ctor(v)
	return `${name ? name + " " : ""}{${shown.join(", ")}${keys.length > 4 ? ", …" : ""}}`
}

// what opens under a value: label, value
function children(v: object): [string, unknown][] {
	const tag = tagOf(v)
	if (tag === "Map") return [...(v as Map<unknown, unknown>)].map(([a, b]) => [preview(a, 1), b])
	if (tag === "Set") return [...(v as Set<unknown>)].map((x, i) => [String(i), x])
	const out: [string, unknown][] = []
	if (Array.isArray(v) || ArrayBuffer.isView(v)) {
		const a = Array.from(v as unknown as ArrayLike<unknown>)
		for (let i = 0; i < Math.min(a.length, 200); i++) out.push([String(i), a[i]])
		if (a.length > 200) out.push(["…", `${a.length - 200} more`])
		return out
	}
	for (const k of Reflect.ownKeys(v).slice(0, 200)) out.push([key(k), get(v, k)])
	return out
}

const type = (v: unknown) => (v === null ? "null" : typeof v)

// ---- patching in place: a fresh build laid over what is on the page ----
// a part of the page that redraws often is built fresh, then laid over what is there: an element
// of the same tag (and data-key) is kept and given the fresh one's attributes, text, handlers and
// $-fields; the rest is put in or taken out. what is kept keeps its scroll, selection and focus.
// what a person opened or shut is theirs: a <details>' open is never laid over, and an element whose
// fresh build has $adopt(fresh, old) is handed the old first, to carry its own state (an open value,
// a shut map). so a handler finds what it changes from its event, never from a variable: the
// elements it was built with are thrown away when what is on the page is kept
const HANDLERS = [
	"onclick",
	"ondblclick",
	"onkeydown",
	"oninput",
	"onchange",
	"onpointerdown",
	"onpointerup",
] as const
type Adopting =
	& Element
	& { $adopt?: (fresh: Element, old: Element) => void }
	& Record<
		string,
		unknown
	>
const sameKind = (a: Node, b: Node) =>
	a.nodeType === b.nodeType &&
	(a.nodeType !== 1 ||
		((a as Element).tagName === (b as Element).tagName &&
			(a as HTMLElement).dataset?.key === (b as HTMLElement).dataset?.key))
function lay(old: Element, fresh: Element) {
	const o = old as Adopting, f = fresh as Adopting
	f.$adopt?.(fresh, old)
	const details = old.tagName === "DETAILS"
	for (const a of [...fresh.attributes]) {
		if (details && a.name === "open") continue
		if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value)
	}
	for (const a of [...old.attributes]) {
		if (details && a.name === "open") continue
		if (!fresh.hasAttribute(a.name)) old.removeAttribute(a.name)
	}
	for (const k of HANDLERS) if (o[k] !== f[k]) o[k] = f[k]
	for (const k of Object.keys(f)) if (k.startsWith("$")) o[k] = f[k]
	if (/^(INPUT|TEXTAREA|SELECT)$/.test(old.tagName) && old !== document.activeElement) {
		const v = (fresh as HTMLInputElement).value
		if ((old as HTMLInputElement).value !== v) (old as HTMLInputElement).value = v
	}
	patch(old, [...fresh.childNodes])
}
// into's children made to be these, keeping what is there where it is the same kind
export function patch(into: Node, fresh: readonly (Node | string)[]) {
	const had = [...into.childNodes]
	let i = 0
	for (const x of fresh) {
		const f = typeof x === "string" ? document.createTextNode(x) : x
		const o = had[i++]
		if (o === undefined) into.appendChild(f)
		else if (o === f) continue
		else if (!sameKind(o, f)) into.replaceChild(f, o)
		else if (o.nodeType === 1) lay(o as Element, f as Element)
		else if (o.nodeValue !== f.nodeValue) o.nodeValue = f.nodeValue
	}
	for (; i < had.length; i++) had[i].remove()
}

// a value's row open: its kids made (once) from the value it shows now, and shown
type Row = HTMLElement & { $v?: unknown; $adopt?: (fresh: Element, old: Element) => void }
const kidsOf = (row: Element) => row.querySelector<HTMLElement>(":scope > .kids")
function openRow(row: Row) {
	let kids = kidsOf(row)
	if (!kids) {
		const v = row.$v as object
		kids = h("div", "kids")
		const isError = v instanceof Error || tagOf(v) === "Error"
		if (isError && (v as Error).stack) kids.append(h("pre", "stack", (v as Error).stack))
		if (typeof v === "function") {
			kids.append(h("pre", "stack", Function.prototype.toString.call(v)))
		}
		for (const [k, x] of children(v)) {
			if (isError && (k === "stack" || k === "message")) continue
			kids.append(render(x, k))
		}
		row.append(kids)
	}
	kids.hidden = false
	row.querySelector(":scope > .head > .arrow")!.textContent = "▾"
}
function toggleRow(e: Event) {
	const row = (e.currentTarget as Element).parentElement as Row
	const kids = kidsOf(row)
	if (kids && !kids.hidden) {
		kids.hidden = true
		row.querySelector(":scope > .head > .arrow")!.textContent = "▸"
	} else openRow(row)
}
// a fresh row over one that was open: opened too, so what is under it is laid over what was
function adoptRow(fresh: Element, old: Element) {
	const kids = kidsOf(old)
	if (kids && !kids.hidden) openRow(fresh as Row)
}

// a value, with its label. top: a string shows as it is, not quoted (console.log("hi"))
export function render(v: unknown, label?: string, top = false): HTMLElement {
	const row: Row = h("div", "val")
	const name = label === undefined ? undefined : h("span", "key", label + ": ")
	if (!isObject(v)) {
		if (name) row.append(name)
		row.append(h("span", "p-" + type(v), top && typeof v === "string" ? v : preview(v, 1)))
		return row
	}
	const head = h("div", "head")
	const arrow = h("span", "arrow", "▸")
	head.append(arrow)
	if (name) head.append(name)
	head.append(
		h(
			"span",
			"o-" + (typeof v === "function" ? "fn" : tagOf(v) === "Error" ? "error" : "obj"),
			preview(v),
		),
	)
	row.append(head)
	row.$v = v
	row.$adopt = adoptRow
	head.onclick = toggleRow
	return row
}
