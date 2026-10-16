import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createPlaces, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import * as head from "./_head.ts"
import * as now from "./patch.ts"

function world(lib: typeof now) {
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => overlay.onTableChange(part, id))
	const overlay = lib.createOverlay(table, () => places)
	const places: Places = createPlaces({ root: "R", table: overlay, paths: createPaths(), scheduler: s })
	const host = s.createRootScope([["actor", "host"]])
	const made = s.runWithScope(host, () => createChangeHeader(s))
	let time = made.time
	const header = (): ChangeHeader => ({ ...made, time: ++time })
	const put = (part: Key, id: Id, v: unknown) => table.sub(part, id, createEntry(v, header()) as never)
	const fields = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `field ${i}`]))
	put("value", "N", { theme: { accent: "lemon", font: "chicago" }, n: 0, ...fields })
	const patch = (p: Id) => put("patch", p, { on: "N", part: "value", at: time, patches: [{ path: ["theme", "accent"], value: String(p) }] })
	function edit(part: Key, id: Id, patches: Parameters<typeof update>[1]) {
		const entry = table.get(part, id)! as Entry<unknown>
		update(entry, patches, header())
		overlay.commit([entry])
	}
	let runs = 0
	const watch = (path: string[]) => {
		s.runWithScope(s.createRootScope([["actor", "reader"]]), () => s.createComputer(() => (runs++, places.readValue("value", "N", path)), () => {}))
		s.pulse()
	}
	return { s, table, overlay, put, patch, edit, watch, runs: () => runs }
}
let sink: unknown, n = 0
type Row = (lib: typeof now) => () => void
const rows: [string, number, Row][] = []
for (const k of [1, 10, 100]) rows.push([`write + get, ${k} over it`, k === 100 ? 100 : 1000, (lib) => {
	const w = world(lib); for (let i = 0; i < k; i++) w.patch(`P${i}`); w.overlay.get("value", "N")
	return () => { w.edit("value", "N", [{ path: ["n"], value: ++n }]); sink = w.overlay.get("value", "N") }
}])
for (const k of [0, 100]) rows.push([`in and out, ${k} others`, k === 100 ? 50 : 1000, (lib) => {
	const w = world(lib); for (let i = 0; i < k; i++) w.patch(`P${i}`); w.overlay.get("value", "N")
	return () => { w.patch("Q"); sink = w.overlay.get("value", "N"); w.table.del("patch", "Q"); sink = w.overlay.get("value", "N") }
}])
rows.push(["write + pulse, reader of f3, 1 patch node", 1000, (lib) => {
	const w = world(lib); w.patch("P"); w.watch(["f3"])
	return () => { w.edit("value", "N", [{ path: ["n"], value: ++n }]); w.s.pulse() }
}])
rows.push(["write + pulse, 50 readers of f0..f49, 1 patch node", 300, (lib) => {
	const w = world(lib); w.patch("P"); for (let i = 0; i < 50; i++) w.watch([`f${i}`])
	return () => { w.edit("value", "N", [{ path: ["n"], value: ++n }]); w.s.pulse() }
}])
rows.push(["drag + pulse, reader of theme.accent", 1000, (lib) => {
	const w = world(lib); w.patch("P"); w.watch(["theme", "accent"])
	return () => { w.edit("patch", "P", [{ path: ["patches", 0, "value"], value: `c${n++}` }]); w.s.pulse() }
}])
const only = Deno.args
for (const [name, calls, make] of rows) {
	if (only.length && !only.some((o) => name.includes(o))) continue
	const fs = [make(head), make(now)]
	const times: number[][] = [[], []]
	for (const f of fs) for (let i = 0; i < calls; i++) f()
	for (let r = 0; r < 31; r++) for (let j = 0; j < 2; j++) {
		const t0 = performance.now(); for (let i = 0; i < calls; i++) fs[j](); times[j].push((performance.now() - t0) * 1000 / calls)
	}
	const med = (t: number[]) => Math.min(...t)
	console.log(`${name}\thead ${med(times[0]).toFixed(2)} µs\tnow ${med(times[1]).toFixed(2)} µs`)
}
if (sink === 1) console.log(sink)
