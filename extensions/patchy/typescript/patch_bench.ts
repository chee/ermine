// deno run extensions/patchy/typescript/patch_bench.ts [name…]
// what the overlay costs, on a real table, paths, places and scheduler: µs per call, medians of up
// to 21 rounds. N is a clock face of 50 fields and a theme; each patch node over it sets
// theme.accent. "bare": no overlay, places reads the table itself. a write's header is made once
// (a site's capture is not what this measures). names given: only the rows whose name holds one
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import { createPlaces, type Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createOverlay, type Overlay } from "./patch.ts"

const only = Deno.args

function world(bare = false) {
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => (bare ? places : overlay).onTableChange(part, id))
	const overlay: Overlay = createOverlay(table, () => places)
	const places: Places = createPlaces({
		root: "R",
		table: bare ? table : overlay,
		paths: createPaths(),
		scheduler: s,
	})
	const host = s.createRootScope({ actor: "host" })
	const made = s.runWithScope(host, () => createChangeHeader(s))
	let time = made.time
	const header = (): ChangeHeader => ({ ...made, time: ++time })
	const put = (part: Key, id: Id, v: unknown) =>
		table.sub(part, id, createEntry(v, header()) as never)
	// spread into a literal: one built key by key is a dictionary to v8, 100× slower to copy, and no
	// value read or applied is one
	const fields = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `field ${i}`]))
	put("value", "N", { theme: { accent: "lemon", font: "chicago" }, n: 0, ...fields })
	// patch node p over on, setting theme.accent
	const patch = (p: Id, on: Id = "N") =>
		put("patch", p, {
			on,
			part: "value",
			at: time,
			patches: [{ path: ["theme", "accent"], value: String(p) }],
		})
	// patches to the entry there, said
	function edit(part: Key, id: Id, patches: Parameters<typeof update>[1]) {
		const entry = table.get(part, id)! as Entry<unknown>
		update(entry, patches, header())
		if (bare) places.commit([entry])
		else overlay.commit([entry])
	}
	const get = bare ? table.get : overlay.get
	// a compute reading N at path, its runs counted
	function watch(path: (string | number)[]) {
		const w = { runs: 0 }
		s.runWithScope(
			s.createRootScope({ actor: "reader" }),
			() => s.createComputer(() => (w.runs++, places.readValue("value", "N", path)), () => {}),
		)
		s.pulse()
		return w
	}
	return { s, table, overlay, put, patch, edit, get, watch }
}

// 21 rounds, or as many past 5 as fit in two seconds
function median(f: () => void, calls: number): number {
	for (let i = 0; i < calls; i++) f()
	const times: number[] = []
	const start = performance.now()
	for (let r = 0; r < 21; r++) {
		const t0 = performance.now()
		for (let i = 0; i < calls; i++) f()
		times.push((performance.now() - t0) * 1000 / calls)
		if (r >= 4 && performance.now() - start > 2000) break
	}
	return times.sort((a, b) => a - b)[times.length >> 1]
}
function row(name: string, f: () => void, calls: number, note?: () => string) {
	if (only.length && !only.some((o) => name.includes(o))) return
	const us = median(f, calls)
	console.log(`${name}\t${us.toFixed(3)} µs${note ? `\t${note()}` : ""}`)
}

let sink: unknown

// reads: get("value", N), nothing changed since the last
{
	const w = world(true)
	row("get, bare", () => sink = w.get("value", "N"), 100000)
}
{
	const w = world()
	row("get, no patch nodes", () => sink = w.get("value", "N"), 100000)
	for (let i = 0; i < 1000; i++) w.patch(`P${i}`, `T${i}`)
	row("get, 1000 patch nodes over others", () => sink = w.get("value", "N"), 100000)
}
for (const k of [1, 10, 100]) {
	const w = world()
	for (let i = 0; i < k; i++) w.patch(`P${i}`)
	row(`get, ${k} patch nodes over it`, () => sink = w.get("value", "N"), 100000)
}

// writes: one field of N, said, then a get (where the overlay makes its entry again)
let n = 0
const field = () => [{ path: ["n"], value: ++n }]
{
	const w = world(true)
	row("write, bare", () => (w.edit("value", "N", field()), sink = w.get("value", "N")), 2000)
}
{
	const w = world()
	row(
		"write, no patch nodes",
		() => (w.edit("value", "N", field()), sink = w.get("value", "N")),
		2000,
	)
	for (let i = 0; i < 1000; i++) w.patch(`P${i}`, `T${i}`)
	row(
		"write, 1000 patch nodes over others",
		() => (w.edit("value", "N", field()), sink = w.get("value", "N")),
		2000,
	)
}
for (const k of [1, 10, 100]) {
	const w = world()
	for (let i = 0; i < k; i++) w.patch(`P${i}`)
	row(
		`write, ${k} patch nodes over it`,
		() => (w.edit("value", "N", field()), sink = w.get("value", "N")),
		k === 100 ? 200 : 2000,
	)
}

// a patch node put over N and taken out, a get after each
for (const k of [0, 10, 100]) {
	const w = world()
	for (let i = 0; i < k; i++) w.patch(`P${i}`)
	row(
		`patch node in and out, ${k} others over it`,
		() => {
			w.patch("Q")
			sink = w.get("value", "N")
			w.table.del("patch", "Q")
			sink = w.get("value", "N")
		},
		k === 100 ? 200 : 2000,
	)
}

// a reader of theme.accent; a write to n, or to the patch node's colour (a drag), then a pulse.
// runs: how many times the reader ran per write
for (
	const [name, bare, patched] of [["bare", true, 0], ["no patch nodes", false, 0], [
		"1 patch node",
		false,
		1,
	]] as const
) {
	const w = world(bare)
	if (patched) w.patch("P")
	const r = w.watch(["theme", "accent"])
	const before = r.runs
	let calls = 0
	row(
		`write n + pulse, reader of theme.accent, ${name}`,
		() => (calls++, w.edit("value", "N", field()), w.s.pulse()),
		2000,
		() => `${((r.runs - before) / calls).toFixed(2)} runs/write`,
	)
}
{
	const w = world()
	w.patch("P")
	const r = w.watch(["theme", "accent"])
	const before = r.runs
	let calls = 0
	row(
		"drag the patch node's colour + pulse, reader of theme.accent",
		() => (calls++,
			w.edit("patch", "P", [{ path: ["patches", 0, "value"], value: `c${n++}` }]),
			w.s.pulse()),
		2000,
		() => `${((r.runs - before) / calls).toFixed(2)} runs/write`,
	)
}

if (sink === Symbol.for("never")) console.log(sink)
