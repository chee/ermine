// What the apply and commit fixtures share: blops made and named, their JSON form, the steps of a
// session (session.ts has the protocol), and a small model of APPLY.tex used only to check the
// expectations written by hand. Patch semantics: mutate.ts; changes and becauses: nodes/ts. The
// names: blop.ts (BLOP.tex), as the history fixtures. apply.ts and commit.ts are never imported.
import { encode, name } from "@ermine/encoding/blop"
import mutate from "@ermine/op/mutate"
import createEntry, { type Entry } from "@ermine/node/entry"
import createChange from "@ermine/change"
import createBecause from "@ermine/change/because"
import { toJson } from "../pack/form.ts"
import { assertEquals } from "@std/assert"

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

export type Which = "value" | ["info", string] | ["children", string]
export type Blop = Record<string, unknown>
export type B = { blop: Blop; name: string; bytes: Uint8Array; lamport: number; time: number }

export const KEY = new Uint8Array(32).fill(1)
let count = 0
let clock = 1000
export type Make = {
	object?: Which
	parents?: B[]
	base?: B
	combine?: true
	patches?: unknown[]
	actor?: unknown
	reader?: string
	site?: Record<string, unknown>
	cause?: unknown
	wallclock?: number
	message?: string
	signer?: Uint8Array
	nonce?: Uint8Array
	lamport?: number
}
// a blop of node "n": parents sorted by name; lamport one more than the parents' highest, 1 with
// none; base, with two or more parents, the one given, else the first; each its own nonce
// and the time this device took it in
export function mk(m: Make = {}): B {
	count++
	const parents = [...(m.parents ?? [])].sort((a, b) => a.name < b.name ? -1 : 1)
	const lamport = m.lamport ??
		(parents.length ? Math.max(...parents.map((p) => p.lamport)) + 1 : 1)
	const blop: Blop = {
		node: "n",
		object: m.object ?? "value",
		actor: "actor" in m ? m.actor : "a",
	}
	if (m.reader !== undefined) blop.reader = m.reader
	if (m.site !== undefined) blop.site = m.site
	if (m.cause !== undefined) blop.cause = m.cause
	if (m.wallclock !== undefined) blop.wallclock = m.wallclock
	if (m.message !== undefined) blop.message = m.message
	blop.signer = m.signer ?? KEY
	blop.nonce = m.nonce ?? Uint8Array.from({ length: 8 }, (_, i) => (count >> (8 * i)) & 0xff)
	blop.parents = parents.map((p) => p.bytes)
	if (parents.length >= 2) blop.base = (m.base ?? parents[0]).bytes
	if (m.combine) blop.combine = true
	blop.lamport = lamport
	blop.patches = m.patches ?? []
	return named(blop)
}
// a blop as given, named
export function named(blop: Blop): B {
	const bytes = name(encode(blop as never))
	return { blop, name: hex(bytes), bytes, lamport: blop.lamport as number, time: clock++ }
}

// the JSON form (form.ts)
export const form = (b: B | Blop): unknown => toJson("blop" in b ? b.blop : b)

export const put = (value: unknown) => [{ path: [], value }]
export const set = (path: (string | number)[], value: unknown) => [{ path, value }]
export const removal = [{ path: [] }]
const byName = (bs: B[]) => [...bs].sort((a, b) => a.name < b.name ? -1 : 1)
// of blops equal in lamport, the agreed order: the greater name first
export const desc = (...bs: B[]) => byName(bs).reverse()
// the agreed order: higher lamport first; equal, the greater name
export const first = (a: B, b: B) =>
	a.lamport !== b.lamport ? a.lamport > b.lamport : a.name > b.name

// ---- the model: APPLY.tex walked through by hand, small enough to read whole
const NONE = Symbol("none")
type Side = unknown
function scratch(object: Which, content: Side): Entry<unknown, unknown> {
	const vs = content === NONE ? [] : [{ content, change: {} }]
	if (object === "value") return createEntry("n", { value: vs })
	if (object[0] === "info") return createEntry("n", { info: [[object[1], vs]] })
	return createEntry("n", { children: [[object[1], vs as never]] })
}
function firstOf(node: Entry<unknown, unknown>, object: Which): Side {
	const vs = object === "value"
		? node.value
		: (object[0] === "info" ? node.info : node.children).get(object[1]) ?? []
	return vs.length ? vs[0].content : NONE
}
// mutate's patches on content (NONE: an object with no versions); NONE when emptied; throws
// MutateError when refused
export function patch(object: Which, content: Side, patches: unknown[]): Side {
	const node = scratch(object, content)
	mutate(node as never, object, patches as never, { time: 0, actor: null })
	return firstOf(node, object)
}
// a blop's side among those given (all taken in)
export function side(all: B[], b: B): Side {
	const parents = b.blop.parents as Uint8Array[]
	const base = b.blop.base as Uint8Array | undefined ?? (parents.length === 1 ? parents[0] : null)
	const from = base === null ? NONE : side(all, all.find((x) => x.name === hex(base))!)
	return patch(b.blop.object as Which, from, b.blop.patches as unknown[])
}
// the heads of one object among those taken in, in the agreed order
export function heads(all: B[], object: Which): B[] {
	const mine = all.filter((b) => JSON.stringify(b.blop.object) === JSON.stringify(object))
	const named = new Set(mine.flatMap((b) => (b.blop.parents as Uint8Array[]).map(hex)))
	return mine.filter((b) => !named.has(b.name)).sort((a, b) => first(a, b) ? -1 : 1)
}

// ---- versions, in JSON form
export function version(b: B, content: Side): unknown {
	const header: Record<string, unknown> = { actor: b.blop.actor }
	for (const k of ["reader", "site", "cause", "wallclock", "message"]) {
		if (k in b.blop) header[k] = b.blop[k]
	}
	header.time = b.time
	return toJson({
		...(content === NONE ? {} : { content }),
		change: createChange("n", header as never),
		because: createBecause("sync", { lamport: b.lamport, name: b.name }, {
			signer: hex(b.blop.signer as Uint8Array),
		}),
	})
}
// the versions written by hand, [head, content] in order, checked against the model
export function versions(all: B[], object: Which, hand: [B, Side][]): unknown[] {
	// every head is a version, a removal as content NONE; a removal as the only head: none
	const hs = heads(all, object)
	const model = hs.length === 1 && side(all, hs[0]) === NONE
		? []
		: hs.map((h) => [h.name, side(all, h)])
	assertEquals(hand.map(([b, c]) => [b.name, c]), model, "hand-written versions disagree")
	return hand.map(([b, c]) => version(b, c))
}
export const none = NONE

// ---- the steps of a session
export type Step = { request: Record<string, unknown>; expect: unknown }
export const create = (): Step => ({ request: { op: "create", node: "n" }, expect: {} })
export const add = (b: B, expect: unknown = "taken"): Step => ({
	request: { op: "add", blop: form(b), name: b.name },
	expect,
})
export const sideStep = (b: B, content: Side): Step => ({
	request: { op: "side", name: b.name },
	expect: content === NONE ? { none: true } : { side: toJson(content) },
})
// the caller's time for each name: when this device took it in
export const times = (all: B[]) => Object.fromEntries(all.map((b) => [b.name, b.time]))
export const versionsStep = (all: B[], object: Which, hand: [B, Side][]): Step => ({
	request: { op: "versions", object, times: times(all) },
	expect: versions(all, object, hand),
})

export const scenarios: { name: string; scenario: unknown }[] = []
export const scenario = (name: string, title: string, steps: Step[]) =>
	scenarios.push({ name, scenario: { title, steps } })

export async function write(dir: URL) {
	await Deno.mkdir(dir, { recursive: true })
	for await (const f of Deno.readDir(dir)) {
		if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, dir))
	}
	scenarios.forEach(({ name, scenario }, i) => {
		const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
		Deno.writeTextFileSync(new URL(file, dir), JSON.stringify(scenario, null, "\t") + "\n")
	})
	console.log(`${scenarios.length} scenarios`)
}
export { unhex }
