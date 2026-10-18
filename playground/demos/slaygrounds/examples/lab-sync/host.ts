// lab-sync's host: the sync world (@ermine/slaygrounds/sync-world), and what is this example's own.
// joining, a device makes a note of its own and says so in its presence row, renewed by a
// heartbeat. every device shows a note for each row that is alive: when a device leaves, its
// heartbeat stops, its row lapses, and its note drops away. where each one's cursor is goes in its
// row too.
//
// merging is off at first: a note with several versions shows the first, and settle keeps it.
// switched on, this device merges them by eg-walker (@ermine/egwalker): two windows typing in
// one note see one text. it knows the rule either way, so it takes in what a merging device wrote
//
// what this device has, as nodes (local, never synced):
//   /me      who this device is, the server, its own note's commits and fragments
//   /peers   the notes on show: one a live row, this device's first
import { egwalker } from "@ermine/egwalker"
import { createSyncWorld, type Patch } from "@ermine/slaygrounds/sync-world"
import { render } from "ermine-h"

const points = (s: string) => Array.from(s)

const world = await createSyncWorld({
	render,
	room: "ermine://001f0433dad341e9b7664587af0aa79f" + "0".repeat(32),
	merges: { "eg-walker": egwalker },
	style: `
	.pad { position: relative; }
	.pad textarea, .pad .mirror { font: inherit; line-height: 1.4; padding: 4px; margin: 0;
		border: 1px solid #111; box-sizing: border-box; width: 100%; height: 8em; white-space: pre-wrap;
		overflow-wrap: break-word; overflow: auto; }
	.pad textarea { position: relative; background: transparent; resize: vertical; display: block; }
	.pad .mirror { position: absolute; inset: 0; color: transparent; background: #fff;
		border-color: transparent; pointer-events: none; }
	.pad .caret { position: relative; border-left: 2px solid var(--c); margin-left: -1px; }
	.pad .caret::after { content: attr(data-name); position: absolute; top: -1.2em; left: -2px;
		font-size: 10px; line-height: 1.2; color: #fff; background: var(--c); padding: 0 3px;
		white-space: nowrap; }
`,
})
const { s, host, places, sync, device, me } = world

// a write to my note says so in /me
function write(part: "value", id: string, patches: Patch[]) {
	world.write(part, id, patches)
	if (id === mine) changed()
}

let merging = false
let waiting = false
world.about({ merging })
world.local("peers", [])

// ---- my note, and my row in the room ----
const mine = sync.mint()
write("value", mine, [{ path: [], value: "" }])
let cursor: { note: string; from: number; to: number } | undefined
world.join(() => ({ note: mine, cursor }))

// /me again, soon: after a write, an arrival, or the server
function changed() {
	if (waiting) return
	waiting = true
	setTimeout(async () => {
		waiting = false
		const frags = device.fragments(mine)
		world.about({
			merging,
			commits: device.history(mine).all().length,
			loose: (await device.stored(mine)).length,
			fragments: frags.length,
			covered: frags.reduce((t, f) => t + f.members.length, 0),
		})
	}, 30)
}
device.arrived(() => changed())
world.onserver(() => changed())

// ---- the notes on show: one for each live row; each followed as it appears ----
type Peer = {
	who: string
	name: string
	colour: string
	note: string
	me: boolean
	versions: number
}
const ID = /^ermine:\/\/[0-9a-f]{64}$/
let shown = ""
s.runWithScope(host, () =>
	s.createEffect(() => {
		const peers: Peer[] = []
		for (const r of world.rows()) {
			const v = r.value as { name?: string; colour?: string; note?: string }
			if (typeof v?.note !== "string" || !ID.test(v.note)) continue
			const conflicts = places.readValue("conflicts", v.note) as unknown[] | undefined
			peers.push({
				who: r.who,
				name: String(v.name ?? r.who.slice(0, 8)),
				colour: String(v.colour ?? "#888"),
				note: v.note,
				me: r.who === me,
				versions: 1 + (conflicts?.length ?? 0),
			})
		}
		return peers.sort((a, b) => Number(b.me) - Number(a.me) || (a.name < b.name ? -1 : 1))
	}, (peers) => {
		for (const p of peers) if (p.note !== mine) world.follow(p.note)
		const now = JSON.stringify(peers)
		if (now !== shown) (shown = now, world.set("peers", peers))
	}))

// ---- a note's pad: its text, and the others' cursors drawn in a mirror behind it ----
const esc = (t: string) =>
	t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
// where a position in a was, in b: the unchanged start and end hold it, the middle moves it
function carry(a: string, b: string, pos: number) {
	let p = 0
	while (p < a.length && p < b.length && a[p] === b[p]) p++
	let q = 0
	while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
	if (pos <= p) return pos
	if (pos >= a.length - q) return pos + (b.length - a.length)
	return p
}
// code points before a UTF-16 offset
const cp = (t: string, units: number) => points(t.slice(0, units)).length
type Mark = { from: number; to: number; colour: string; name: string }

const pads = new Map<string, HTMLElement>()
function pad(note: string): HTMLElement {
	const kept = pads.get(note)
	if (kept) return kept
	const box = document.createElement("div")
	box.className = "pad"
	const mirror = box.appendChild(document.createElement("div"))
	mirror.className = "mirror"
	const area = box.appendChild(document.createElement("textarea"))
	area.spellcheck = false
	area.placeholder = note === mine ? "your note: type here" : ""
	let text = ""
	// where my cursor is in this note: sent with the next beat
	const where = () => {
		const next = {
			note,
			from: cp(area.value, area.selectionStart),
			to: cp(area.value, area.selectionEnd),
		}
		if (JSON.stringify(next) !== JSON.stringify(cursor)) (cursor = next, world.touch())
	}
	area.addEventListener("input", () => {
		const a = points(text), b = points(area.value)
		let p = 0
		while (p < a.length && p < b.length && a[p] === b[p]) p++
		let q = 0
		while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) {
			q++
		}
		text = area.value
		write("value", note, [{
			path: [],
			range: [p, a.length - q],
			value: b.slice(p, b.length - q).join(""),
		}])
		where()
	})
	for (const e of ["keyup", "mouseup", "select", "focus"]) area.addEventListener(e, where)
	area.addEventListener("blur", () => (cursor = undefined, world.touch()))
	area.addEventListener("scroll", () => (mirror.scrollTop = area.scrollTop))
	// the text and the cursors on it, drawn again when either changes
	s.runWithScope(host, () =>
		s.createEffect(() => {
			const v = places.readValue("value", note)
			const marks: Mark[] = []
			for (const r of world.rows()) {
				const row = r.value as { cursor?: { note: string; from: number; to: number } } & Mark
				if (r.who === me || row?.cursor?.note !== note) continue
				marks.push({ ...row.cursor, colour: row.colour, name: row.name })
			}
			return { next: typeof v === "string" ? v : "", marks }
		}, ({ next, marks }) => {
			if (next !== area.value) {
				const focus = document.activeElement === area
				const [s0, e0] = [area.selectionStart, area.selectionEnd]
				area.value = next
				if (focus) area.setSelectionRange(carry(text, next, s0), carry(text, next, e0))
			}
			text = next
			const chars = points(next)
			let out = "", i = 0
			const lo = (m: Mark) => Math.min(m.from, m.to)
			for (const m of marks.sort((a, b) => lo(a) - lo(b))) {
				const at = lo(m), end = Math.max(m.from, m.to)
				if (at < i || at > chars.length) continue
				out += esc(chars.slice(i, at).join(""))
				if (end > at) {
					out += `<mark style="background:color-mix(in srgb, ${m.colour} 35%, transparent)">${
						esc(chars.slice(at, end).join(""))
					}</mark>`
				}
				out += `<span class="caret" data-name="${esc(m.name)}" style="--c:${m.colour}"></span>`
				i = end
			}
			mirror.innerHTML = out + esc(chars.slice(i).join("")) + "\n"
		}))
	pads.set(note, box)
	return box
}

// ---- what the program is handed ----
const tools = {
	me,
	// a note's pad, kept across reloads: put it in the view as it is
	pad,
	// n letters typed at the end of my note, each its own commit (fragments start about every 256)
	type(n: number, letters = "ermine ") {
		const v = places.readValue("value", mine)
		let at = typeof v === "string" ? points(v).length : 0
		for (let i = 0; i < n; i++) {
			write("value", mine, [{ path: [], range: [at, at], value: letters[i % letters.length] }])
			at++
		}
	},
	// a note's versions made one, keeping the one shown
	settle: world.settle,
	// merging by eg-walker, on or off: what each note with several versions shows changes at once
	merge(on: boolean) {
		merging = on
		sync.use(on ? "eg-walker" : undefined)
		changed()
		s.pulse()
	},
}
export type Tools = typeof tools

export const reload = (mod: { default: (t: Tools) => unknown }) => world.reload(mod, tools)
