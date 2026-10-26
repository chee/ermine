// a patch node, told as a story: deno run example.ts
// chee's clock face N sits at /work/clock; antranig's skin P sits in my tree at /me/skins/cherry
// and changes one colour of N, without writing on N
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { createPlaces, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { get } from "@ermine/places/lib"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createOverlay, entries, type Item, type Overlay } from "./typescript/patch.ts"

const s = createScheduler()
s.onTrackingEnd((key) => places.release(key))
const table = createTable((part, id) => overlay.onTableChange(part, id))
const overlay: Overlay = createOverlay(table, () => places)
const places: Places = createPlaces({
	root: "R",
	table: overlay,
	paths: createPaths(),
	scheduler: s,
})

const host = s.createRootScope({ actor: "host" })
const header = (actor: string, time: number) => {
	const h = s.runWithScope(host, () => createChangeHeader(s))
	return { ...h, actor, time }
}
const put = (part: Key, id: Id, v: unknown, actor = "host", time = 1792000000) =>
	table.sub(part, id, createEntry(v, header(actor, time)) as never)

put("children", "R", { work: "W", me: "M" })
put("children", "W", { clock: "N" })
put("children", "M", { skins: "S" })
put("value", "N", { theme: { accent: "lemon", font: "chicago" } }, "chee")

// the reader: the clock face, drawn from /work/clock
let runs = 0, accent: unknown, font: unknown, layers: Item[] = []
s.runWithScope(s.createRootScope({ actor: "face" }), () =>
	s.createComputer(() => {
		runs++
		const id = get(places, ["work", "clock"])!
		return {
			accent: places.readValue("value", id, ["theme", "accent"]),
			font: places.readValue("value", id, ["theme", "font"]),
			layers: entries(places, overlay, "value", id, ["theme", "accent"]),
		}
	}, (v) => ({ accent, font, layers } = v)))

const show = (item: Item) =>
	`${JSON.stringify(item.value)} ← ${String(item.from)}${item.stale ? " (stale)" : ""}`
function tell(title: string, note?: string) {
	s.pulse()
	console.log(`\n${title}`)
	if (note) console.log(`  ${note}`)
	console.log(`  the face draws accent ${JSON.stringify(accent)}, font ${JSON.stringify(font)}`)
	console.log(`  entries at theme.accent: ${layers.map(show).join("  ·  ")}`)
	console.log(`  N in the table: ${JSON.stringify(table.get("value", "N")!.value)}`)
	console.log(`  the face has run ${runs}×`)
}

console.log("patch nodes: a node that lives in one place and changes another")
tell("1. the base", "chee's clock face N at /work/clock")

put("children", "S", { cherry: "P" })
put("patch", "P", {
	on: "N",
	part: "value",
	at: table.get("value", "N")!.change.time,
	patches: [{ path: ["theme", "accent"], value: "cherry" }],
}, "antranig")
const found = String(get(places, ["me", "skins", "cherry"]))
tell(
	"2. the override on",
	`antranig's skin P, at /me/skins/cherry (a walk there finds ${found}), on N`,
)

const n = table.get("value", "N")!
update(n, [{ path: ["theme", "accent"], value: "lime" }], header("chee", 1792000060))
overlay.commit([n])
tell(
	"3. the base changes",
	"chee sets accent to lime: a real write to N. P was made against N at 1792000000, N is at 1792000060 now: stale, still applied",
)

table.del("patch", "P")
put("children", "S", {})
tell("4. the override taken out", "P unloaded: the face sees N as it is")
