/// <reference lib="dom" />
// edit a node's value (or attributes) as JSON in the graph view. what is typed is diffed against
// the value into patches by op's produce (nothing of our own but the recipe that walks the new
// value onto the draft, and a string's common prefix and suffix for produce's splice), shown,
// then written as an ordinary change through the world: a scope under the host's, update with
// header, places.commit, a pulse
import { h } from "./values.ts"
import { write as writeTo } from "./solid-ermine.ts"

// deno-lint-ignore no-explicit-any
type Any = any
type Where = { id: unknown; part: string }

// op's produce, loaded when first needed; update is the world's own (its iframe's import map)
const lib = async () => ({ produce: (await import("@ermine/op/produce")).default })

const container = (v: unknown) => typeof v === "object" && v !== null
// JSON only: null, booleans, finite numbers, strings, lists, plain maps (another realm's too)
export function json(v: unknown): boolean {
	if (v === null || typeof v === "boolean" || typeof v === "string") return true
	if (typeof v === "number") return Number.isFinite(v)
	if (Array.isArray(v)) return v.every(json)
	if (!container(v)) return false
	const p = Object.getPrototypeOf(v)
	if (p !== null && Object.getPrototypeOf(p) !== null) return false
	return Object.values(v as object).every(json)
}

const codes = (s: string) => Array.from(s)

const same = (a: unknown, b: unknown) =>
	container(a) && container(b) && Array.isArray(a) === Array.isArray(b)

// what a string's ends share is left alone: the span between them is the one splice
function span(a: string, b: string) {
	const x = codes(a), y = codes(b)
	let start = 0
	while (start < x.length && start < y.length && x[start] === y[start]) start++
	let end = 0
	while (
		end < x.length - start && end < y.length - start &&
		x[x.length - 1 - end] === y[y.length - 1 - end]
	) end++
	return [
		start,
		x.length - start - end,
		y.slice(start, y.length - end).join("") || undefined,
	] as const
}

// walk b onto the draft a: set what differs, delete what is gone, lists by index and length
function into(a: Any, b: Any, splice: Any) {
	if (Array.isArray(b)) {
		for (let i = 0; i < Math.min(a.length, b.length); i++) onto(a, i, b[i], splice)
		if (b.length > a.length) a.push(...b.slice(a.length))
		else if (b.length < a.length) a.length = b.length
	} else {
		for (const k of Object.keys(b)) onto(a, k, b[k], splice)
		for (const k of Object.keys(a)) if (!(k in b)) delete a[k]
	}
}
function onto(parent: Any, key: string | number, b: Any, splice: Any) {
	const a = parent[key]
	if (Object.is(a, b)) return
	if (typeof a === "string" && typeof b === "string") splice(parent, key, ...span(a, b))
	else if (same(a, b)) into(a, b, splice)
	else parent[key] = b
}

// the patches that turn current into next
export async function diff(current: unknown, next: unknown) {
	const { produce } = await lib()
	return produce(current as Any, (draft: Any, { splice }: Any) => {
		if (typeof current === "string" && typeof next === "string") {
			const [start, remove, insert] = span(current, next)
			if (start + remove > 0 || insert !== undefined) splice(current, start, remove, insert)
		} else if (same(current, next)) into(draft, next, splice)
		else return next
	})
}

// a small editor in place of the shown value; done is told when it closes
// importIn: imports a module inside the program's frame: update must run there, in the realm of
// the values it changes (apply tells maps by prototype)
export function edit(
	slot: HTMLElement,
	world: Any,
	where: Where,
	done: () => void,
	importIn: (specifier: string) => Promise<Any>,
) {
	const node = world.table.get(where.part, where.id)
	slot.replaceChildren()
	if (!json(node.value)) {
		slot.append(
			h(
				"p",
				"empty",
				"not editable here: this holds more than JSON (bytes, a function, a symbol, a Map…)",
			),
		)
		const back = slot.appendChild(h("button", "", "close"))
		back.onclick = done
		return
	}
	const box = slot.appendChild(h("textarea", "json"))
	box.value = JSON.stringify(node.value, null, 2)
	box.rows = Math.min(12, box.value.split("\n").length + 1)
	box.spellcheck = false
	const preview = slot.appendChild(h("div", "patches"))
	const row = slot.appendChild(h("div", "ibar"))
	const save = row.appendChild(h("button", "", "save"))
	const cancel = row.appendChild(h("button", "", "cancel"))
	let patches: Any[] | undefined
	let seq = 0
	const check = async () => {
		const mine = ++seq
		try {
			const next = JSON.parse(box.value)
			// a copy made here: the program's objects are another realm's, which produce will not draft
			const out = await diff(JSON.parse(JSON.stringify(node.value)), next)
			if (mine !== seq) return
			patches = out
			preview.replaceChildren(
				h(
					"div",
					"empty",
					out.length ? `${out.length} patch${out.length > 1 ? "es" : ""}` : "no change",
				),
				...out.map((p: Any) => {
					const parts = [`path ${JSON.stringify(p.path)}`]
					if (p.range) parts.push(`range ${JSON.stringify(p.range)}`)
					if ("value" in p) parts.push(`value ${JSON.stringify(p.value)}`)
					return h("div", "patch", parts.join("  "))
				}),
			)
			save.disabled = !out.length
		} catch (e) {
			patches = undefined
			save.disabled = true
			preview.replaceChildren(h("div", "patch bad", (e as Error).message))
		}
	}
	const write = async () => {
		if (!patches?.length) return
		const { default: update } = await importIn("@ermine/node/update")
		writeTo(world, where, patches, update)
		done()
	}
	box.oninput = check
	box.onkeydown = (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") (e.preventDefault(), write())
		if (e.key === "Escape") done()
	}
	save.onclick = write
	cancel.onclick = done
	check()
	box.focus()
}
