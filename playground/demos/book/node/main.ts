/// <reference lib="dom" />
// inside a node: each fish in the pond is a node, its entries in three tables (value, attributes,
// children), all at one id. the tables are boxes on the board, one row per id; the pond is drawn
// from them. pick a fish (in the pond or a row) and its row lights in every table, and the node
// box shows table.get(id): the whole row, which is all a node is.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import createNode from "@ermine/core/node"
import update from "@ermine/core/changeable/update"
import { createTable, type Key } from "@ermine/core/table"
import { pondPage } from "../kit/page.ts"
import type { Box, Wire } from "../kit/board.ts"
import { createPond, recolour, SPRITES } from "../kit/sprites.ts"

const page = pondPage("node", {
	say:
		`<p>Every fish in this pond is a <b>node</b>. A node isn't one object: it's an <b>id</b>, and whatever sits at that id in each <b>table</b>.</p>
		<p>Here there are three tables: <code>value</code> (its name and size), <code>attributes</code> (its colour) and <code>children</code> (its eggs, by name).</p>`,
	tries: [
		{ id: "pick", text: "Click a fish. Its row lights up in all three tables." },
		{
			id: "feed",
			text: "Feed it. Its value changes, but the table isn't told: same entry, same cell.",
		},
		{
			id: "fish",
			text: "Add a fish. Three entries go into three tables, and each table says so.",
		},
		{ id: "egg", text: "Lay an egg. A new node, and a name in its parent's children." },
		{ id: "twin", text: "Make a twin: one value entry at two ids. Feed one and both grow." },
	],
	rules:
		`<p><b>entry:</b> a value and the change that last made it (when, who, where in code). An entry has no id.</p>
		<p><b>table:</b> keeps entries under a table name and an id. <code>add</code> puts one in a cell and tells its listener <code>[table, id]</code>. A cell already holding a different entry refuses.</p>
		<p><b>node:</b> everything at one id. <code>get(id)</code> gives back that row. <code>createNode</code> is a shortcut: one entry per table, sharing one change.</p>
		<p><b>update:</b> changes an entry's value in place and replaces its change. The table holds the same entry, so it's never told. Telling readers is the scheduler's job, later in the book.</p>
		<p><b>children:</b> a folder is just a children entry: names to ids. An egg is placed by one update on its parent's children.</p>
		<p><b>one entry, many cells:</b> the same entry can sit at two ids. <code>who(entry)</code> lists where.</p>`,
	real:
		`Runs the real <code>@ermine/core/table</code> (createTable: add, get, who) and <code>@ermine/core/node</code> (createNode, createEntry, update). The page keeps a list of the ids it added (a table can't list its ids), draws the boxes and the pond, and names entries e1, e2… so you can tell them apart.`,
})
const { board } = page

// ---- the real table, and what it tells ------------------------------------------------------
const told: [Key, string][] = []
const table = createTable((part, id) => told.push([part, id as string]))
const ids: string[] = []
const names = new WeakMap<object, string>()
let count = 0
const tag = (e: object) => {
	if (!names.has(e)) names.set(e, `e${++count}`)
	return names.get(e)!
}
const header = (): ChangeHeader => ({ time: Math.floor(Date.now() / 1000), actor: "you" })

type Fish = { name: string; size: number }
const COLOURS = ["orange", "pink", "blue", "gold"]
const short = () => Math.random().toString(36).slice(2, 5)

function addFish(name: string, colour: string, at?: { x: number; y: number }) {
	const id = short()
	const node = createNode({
		value: { name, size: 2 } as Fish,
		attributes: { colour },
		children: {},
	}, header())
	for (const part of ["value", "attributes", "children"] as const) {
		table.add(part, id, node[part] as never)
	}
	ids.push(id)
	homes.set(id, at ?? { x: 0.1 + Math.random() * 0.8, y: 0.1 + Math.random() * 0.8 })
	return id
}

// a fish in each colour
const FISH: Record<string, string[]> = {
	orange: recolour("fish", {}),
	pink: recolour("fish", { O: "P", o: "n" }),
	blue: recolour("fish", { O: "b", o: "B" }),
	gold: recolour("fish", { O: "Y", o: "y" }),
	yellow: recolour("fish", { O: "Y", o: "y" }),
}

// where each fish swims, as fractions of the pond: the page's, not the graph's
const homes = new Map<string, { x: number; y: number }>()

// ---- the board -----------------------------------------------------------------------------
const pic = board.box({
	id: "pond",
	x: 20,
	y: 40,
	title: "the pond",
	kind: "picture",
	outs: [["out", ""]],
})
const canvas = document.createElement("canvas")
canvas.style.cursor = "pointer"
pic.body.append(canvas)
const hint = document.createElement("div")
hint.className = "small"
hint.textContent = "click a fish"
pic.body.append(hint)
const pond = createPond(canvas, { width: 240, height: 140 })
pic.removePort("out")

const PARTS: Key[] = ["value", "attributes", "children"]
const tables = new Map<string, Box>()
const TX = 560
PARTS.forEach((p, i) => {
	const b = board.box({
		id: `t:${p}`,
		x: TX,
		y: 20 + i * 150,
		title: `table: ${p}`,
		outs: [["out", ""]],
		width: 280,
	})
	tables.set(p, b)
})
const nodeBox = board.box({
	id: "node",
	x: 920,
	y: 150,
	title: "node",
	kind: "note",
	width: 260,
	ins: [],
})
const doBox = board.box({ id: "do", x: 20, y: 370, title: "do", kind: "key", width: 500 })
doBox.body.innerHTML = `<div class="chips">
	<button class="chip" data-do="feed">feed it</button>
	<button class="chip" data-do="rename">rename it</button>
	<button class="chip" data-do="egg">lay an egg</button>
	<button class="chip" data-do="fish">add a fish</button>
	<button class="chip" data-do="twin">make a twin</button>
	<button class="chip" data-do="clash">put a new entry in a full cell</button>
</div>
<div class="small" style="margin-top:6px">acts on the fish you picked</div>`
tables.get("value")!.code(`// a fish's three entries, made at once,
// sharing one change
const node = createNode(
  { value: { name, size: 2 },
    attributes: { colour },
    children: {} },
  header,
)
table.add("value", id, node.value)
table.add("attributes", id, node.attributes)
table.add("children", id, node.children)`)
nodeBox.code(`table.get(id)
// → [["value", e1], ["attributes", e2],
//    ["children", e3]]`)
doBox.code(`// feed: one update, in place
update(table.get("value", id),
  [{ path: ["size"], value: size + 1 }], header)

// lay an egg: a new node, and its name
// put in the parent's children
update(table.get("children", id),
  [{ path: ["egg 1"], value: eggId }], header)

// a twin: the same value entry at a new id
table.add("value", twinId,
  table.get("value", id))`)

let picked: string | undefined
const wires = new Map<string, Wire>()
for (const p of PARTS) {
	const port = nodeBox.addPort(p, "in")
	wires.set(p, board.wire(tables.get(p)!.port("out"), port))
}

// ---- drawing -------------------------------------------------------------------------------
const show = (v: unknown) => JSON.stringify(v)
const SWATCH: Record<string, string> = {
	orange: "#ff8a1f",
	pink: "#ff2284",
	blue: "#9fc0ff",
	gold: "#ffe23d",
	yellow: "#ffe23d",
}
// a cell's value in words: hover it for the value itself
function friendly(p: Key, v: unknown): string {
	if (p === "value") {
		const f = v as Fish
		return f.size === 0 ? `${esc(f.name)}, an egg` : `${esc(f.name)}, size ${f.size}`
	}
	if (p === "attributes") {
		const c = (v as { colour?: string }).colour ?? ""
		return `<i class="sw" style="background:${SWATCH[c] ?? "#ccc"}"></i>${esc(c)}`
	}
	if (p === "children") {
		const k = Object.entries(v as Record<string, string>)
		return k.length
			? k.map(([n, i]) => `${esc(n)} → ${esc(i)}`).join(", ")
			: `<span class="small">no eggs</span>`
	}
	return esc(show(v))
}
const colourOf = (id: string) =>
	(table.get("attributes", id)?.value as { colour?: string } | undefined)?.colour ?? "orange"
const label = (id: string) => {
	const v = table.get("value", id)?.value as Fish | undefined
	return v?.name ?? id
}
function draw(flashCells: [Key, string][] = []) {
	for (const p of PARTS) {
		const b = tables.get(p)!
		const rows = ids.filter((id) => table.get(p, id)).map((id) => {
			const e = table.get(p, id)!
			const shared = table.who(e).length > 1
			const lit = flashCells.some(([fp, fid]) => fp === p && fid === id)
			return `<div class="row ${id === picked ? "picked" : ""} ${
				lit ? "lit" : ""
			}" data-id="${id}">
				<b>${id}</b><span class="e ${shared ? "shared" : ""}">${
				tag(e)
			}</span><span class="v" title="${esc(show(e.value))}">${friendly(p, e.value)}</span></div>`
		})
		b.body.innerHTML = `<div class="rows">${
			rows.join("") || `<div class="small">empty</div>`
		}</div>`
		b.badge(`${rows.length} id${rows.length === 1 ? "" : "s"}`)
	}
	// the node: the picked id's row
	if (picked) {
		const row = table.get(picked)
		nodeBox.title(`node ${picked}`)
		nodeBox.body.innerHTML = `<div class="mid">${esc(label(picked))}</div>` +
			row.map(([p, e]) =>
				`<div class="nrow"><span class="small">${String(p)}</span> <span class="e">${
					tag(e)
				}</span> ${friendly(p, e.value)}</div>`
			).join("") +
			`<div class="small" style="margin-top:6px">table.get("${picked}"): ${row.length} entries</div>`
		for (const p of PARTS) {
			const e = table.get(p, picked)
			wires.get(p)!.label(e ? tag(e) : "nothing")
			wires.get(p)!.tone(e ? "pick" : "dim")
		}
		nodeBox.tone("pick")
	} else {
		nodeBox.title("node")
		nodeBox.body.innerHTML =
			`<div class="small">pick a fish: its node is its row in every table</div>`
		for (const w of wires.values()) (w.label(""), w.tone("dim"))
		nodeBox.tone(undefined)
	}
	// the pond: drawn only from the table
	const named = ids.map((id) => {
		const v = table.get("value", id)?.value as Fish | undefined
		const egg = v?.size === 0
		const h = homes.get(id)!
		return {
			name: v?.name ?? "?",
			kind: egg ? "egg" as const : "fish" as const,
			rows: egg ? undefined : FISH[colourOf(id)],
			x: h.x,
			y: h.y,
			tone: id === picked ? "hot" as const : undefined,
		}
	})
	pond.draw({ lilies: 4, minnows: 6, named })
	// the tables stack down the board as they grow
	let y = 20
	for (const p of PARTS) {
		const b = tables.get(p)!
		if (b.pos().y !== y) b.move(TX, y)
		y += b.el.offsetHeight + 28
	}
}

const esc = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

// what the table told, as a flash on each table box and a caption
function act(what: string, f: () => void, tryId?: string) {
	told.length = 0
	try {
		f()
	} catch (e) {
		const code = (e as { code?: string }).code ?? String(e)
		page.say(
			`Refused: <code>${code}</code>. A different entry is already in that cell, so the table said no. Nothing changed.`,
			"hot",
		)
		draw()
		return
	}
	const cells = [...told]
	for (const [p] of cells) tables.get(p)?.flash("hot")
	draw(cells)
	page.say(
		`${what} ${
			cells.length
				? `The table told its listener: ${
					cells.map(([p, i]) => `<code>[${p}, ${i}]</code>`).join(" ")
				}.`
				: `<b>The table told no one</b>: the same entry is still in the same cell.`
		}`,
		cells.length ? undefined : "ok",
	)
	if (tryId) page.tick(tryId)
}

doBox.body.onclick = (e) => {
	const d = (e.target as HTMLElement).closest<HTMLElement>("[data-do]")?.dataset.do
	if (!d) return
	if (d === "fish") {
		const name = ["pip", "nemo", "dot", "kipper", "blue", "fern", "tilly"][ids.length % 7]
		let id = ""
		act(
			`A new fish, <b>${name}</b>: createNode made three entries and the page added each.`,
			() => {
				id = addFish(name, COLOURS[ids.length % COLOURS.length])
			},
			"fish",
		)
		picked = id
		draw()
		return
	}
	if (!picked) return page.say("Pick a fish first: click one in the pond.", "hot")
	const id = picked
	const v = table.get("value", id)
	if (d === "feed") {
		const size = (v?.value as Fish).size
		act(
			`<b>${label(id)}</b> grew to ${size + 1}: one update on ${tag(v!)}, in place.`,
			() => update(v as Entry<Fish>, [{ path: ["size"], value: size + 1 }], header()),
			"feed",
		)
		const twins = table.who(v!).filter(([, i]) => i !== id)
		if (twins.length) {
			page.say(
				`<b>${label(id)}</b> grew, and so did its twin at <code>${
					twins.map(([, i]) => String(i)).join(", ")
				}</code>: it's one entry in two cells. The table told no one.`,
				"ok",
			)
			page.tick("twin")
		}
	} else if (d === "rename") {
		const nn = prompt("a new name", label(id))
		if (!nn) return
		act(
			`Renamed: the value changed, the id <code>${id}</code> didn't. An id is just an address.`,
			() => update(v as Entry<Fish>, [{ path: ["name"], value: nn }], header()),
		)
	} else if (d === "egg") {
		const kids = table.get("children", id)!
		const n = Object.keys(kids.value as object).length + 1
		let eid = ""
		act(
			`<b>${label(id)}</b> laid an egg: a new node, and <code>"egg ${n}"</code> put in ${
				label(id)
			}'s children.`,
			() => {
				const h = homes.get(id)!
				eid = addFish(`egg ${n}`, "yellow", {
					x: Math.min(0.95, h.x + 0.08 * n),
					y: Math.min(0.95, h.y + 0.12),
				})
				update(table.get("value", eid) as Entry<Fish>, [{ path: ["size"], value: 0 }], header())
				update(
					kids as Entry<Record<string, unknown>>,
					[{ path: [`egg ${n}`], value: eid }],
					header(),
				)
			},
			"egg",
		)
	} else if (d === "twin") {
		let tid = ""
		act(
			`A twin at a new id, holding the <b>same</b> value entry ${
				tag(v!)
			}: shared entries are marked green.`,
			() => {
				tid = short()
				table.add("value", tid, v!)
				table.add("attributes", tid, createEntry({ colour: "blue" }, header()))
				ids.push(tid)
				const h = homes.get(id)!
				homes.set(tid, { x: h.x > 0.5 ? h.x - 0.3 : h.x + 0.3, y: Math.min(0.95, h.y + 0.25) })
			},
		)
	} else if (d === "clash") {
		act("", () => table.add("value", id, createEntry({ name: "intruder", size: 1 }, header())))
	}
}

// pick by clicking a row, or a fish in the pond
board.el.addEventListener("click", (e) => {
	const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-id]")
	if (row) {
		picked = row.dataset.id
		draw()
		page.tick("pick")
	}
})
canvas.addEventListener("click", (e) => {
	const r = canvas.getBoundingClientRect()
	const cx = (e.clientX - r.left) * (240 / r.width), cy = (e.clientY - r.top) * (140 / r.height)
	const inner = { x: 14, y: 14, w: 240 - 28, h: 140 - 28 }
	let best: string | undefined, bd = 18
	for (const id of ids) {
		const kind = (table.get("value", id)?.value as Fish).size === 0 ? "egg" : "fish"
		const sw = SPRITES[kind][0].length, sh = SPRITES[kind].length
		const h = homes.get(id)!
		const x = inner.x + h.x * (inner.w - sw) + sw / 2
		const y = inner.y + 7 + h.y * (inner.h - sh - 7) + sh / 2
		const d = Math.hypot(cx - x, cy - y)
		if (d < bd) (bd = d, best = id)
	}
	picked = best
	draw()
	if (best) {
		page.tick("pick")
		page.say(`<b>${label(best)}</b> is node <code>${best}</code>: one row across the tables.`)
	}
})

// a little style for the rows
const style = document.createElement("style")
style.textContent = `
.rows { display: flex; flex-direction: column; gap: 2px; font: 12px var(--mono); }
.row { display: grid; grid-template-columns: 3.2em 2.6em 1fr; gap: 6px; padding: 2px 4px; cursor: pointer; border: 1px solid transparent; }
.row:hover { background: var(--lemon); }
.row.picked { background: var(--sky); border-color: var(--blue); }
.row.lit { animation: flash .9s ease-out; }
.row .v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e { font: 700 11px var(--mono); }
.e.shared { background: var(--stem); padding: 0 3px; }
.nrow { font: 12px var(--mono); padding: 1px 0; display: grid; grid-template-columns: 6.5em 2.6em 1fr; gap: 4px; }
.sw { display: inline-block; width: 10px; height: 10px; border: 1px solid #000; margin-right: 5px; vertical-align: -1px; }
`
document.head.append(style)

// the pond to start: three fish
for (
	const [n, c, x, y] of [["goldie", "orange", 0.2, 0.3], ["pip", "pink", 0.6, 0.6], [
		"fern",
		"blue",
		0.75,
		0.2,
	]] as const
) {
	addFish(n, c, { x, y })
}
told.length = 0
draw()
requestAnimationFrame(() => board.fit())
