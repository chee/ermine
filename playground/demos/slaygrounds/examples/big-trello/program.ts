/** @jsxImportSource ermine-h */
import apply, { type Patch } from "@ermine/core/changeable/apply"
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	hasNode,
	list,
	patch,
	peep,
	place,
	read as readNode,
	ref,
	rename,
	unplace,
} from "@ermine/system"
import { change, who } from "@ermine/slaygrounds/tools"
import { handler } from "ermine-h"

// big-trello: a board. lists are nodes under board/lists, cards nodes under each list's cards,
// each named by its own id; the order is a value of its own: board/lists and every cards node
// hold the array of their children's ids. a drag is a rename (a card to another list; in one
// list only the order changes), so a card keeps its node and its name wherever it goes. a
// removal is a rename into board/trash: no function reaches a node nothing names, so what is
// removed is kept there, and an undo moves it back. while you drag, the drop spot is in the graph too: the card's id placed in the list it hovers under
// the name "drag:<id>", and that name in the list's order (watch the
// graph tab mid-drag). every call that says what it did is one undo step: ⌘Z / ⇧⌘Z, from the
// inverse patches. 🕘 on a list or a card opens its history: undo just one change from the middle,
// and everything after it stays (its inverse rebased through the later changes, as a new change;
// when a later change touched the same thing it says so, and does nothing). double-click a card or
// a list's title to edit it (a splice of the words that changed). edit this file: the board stays
const TINTS = ["none", "cherry", "mint", "blue", "lemon"]
const SEED = [
	["to do", [
		["water the radishes 🌱", "mint"],
		["teach the ermine to fetch", "none"],
		["bake lemon bars", "lemon"],
		["write the process api", "cherry"],
	]],
	["doing", [
		["drag me to another list", "blue"],
		["double-click me to edit", "none"],
	]],
	["done", [
		["find the good scissors ✂️", "none"],
		["name the rabbit", "cherry"],
	]],
]
const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 14px/1.3 Jost, system-ui, sans-serif; color: #000 }
.board { display: flex; flex-direction: column; height: 100vh; padding: 12px 12px 0 }
.top { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap }
.tag { display: inline-block; background: #fff; border: 1px solid #000; padding: 1px 10px;
	transform: skew(-8deg); font-weight: 600 }
.top .title { font-size: 18px; background: #ff2284; color: #fff }
.top .stats { background: #40dcba }
.top .fill { flex: 1 }
button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 1px 10px; box-shadow: 2px 2px 0 #000; cursor: pointer;
	transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
button:active { transform: translate(1px, 1px); box-shadow: 0 0 0 #000 }
button:disabled { opacity: .35; cursor: default; transform: none; box-shadow: 2px 2px 0 #000 }
.lists { flex: 1; display: flex; align-items: flex-start; gap: 12px; overflow-x: auto;
	padding: 2px 2px 14px }
.list { flex: 0 0 200px; display: flex; flex-direction: column; gap: 8px; background: #fff;
	border: 1px solid #000; border-radius: 6px; padding: 8px; box-shadow: 0 0 10px 2px #66003322;
	max-height: calc(100vh - 90px) }
.list > header { display: flex; align-items: center; gap: 6px; cursor: grab; user-select: none }
.list > header .name { background: #ffff88; outline: none; min-width: 2em }
.list > header .count { font-size: 12px; color: #0008; font-variant-numeric: tabular-nums }
.list > header .x { margin-left: auto; padding: 0 6px; box-shadow: 1px 1px 0 #000; font-size: 12px }
.cards { display: flex; flex-direction: column; gap: 6px; min-height: 24px; overflow-y: auto;
	padding: 2px 3px 4px 1px }
.card { position: relative; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 6px 26px 7px 8px; box-shadow: 1px 1px 0 #000; cursor: grab; user-select: none;
	transition: transform 100ms, box-shadow 100ms; overflow-wrap: anywhere }
.card:hover { transform: translate(-1px, -1px); box-shadow: 2px 2px 0 #000 }
.card .text { outline: none; display: block; white-space: pre-wrap }
.card[data-tint=cherry] { background: #ffd9ea } .card[data-tint=mint] { background: #c8f6ea }
.card[data-tint=blue] { background: #d4e4ff } .card[data-tint=lemon] { background: #ffffc2 }
.card:not([data-tint=none])::before { content: ""; display: block; width: 38px; height: 6px;
	border-radius: 3px; margin-bottom: 5px; border: 1px solid #000; background: var(--tint) }
.card[data-tint=cherry] { --tint: #ff2284 } .card[data-tint=mint] { --tint: #40dcba }
.card[data-tint=blue] { --tint: #2269ff } .card[data-tint=lemon] { --tint: #ffff88 }
.card .tools { position: absolute; right: 4px; top: 4px; display: none; flex-direction: column;
	gap: 3px; z-index: 1 }
.card:hover .tools { display: flex }
.card .tools button { width: 18px; height: 18px; padding: 0; font-size: 11px; line-height: 1;
	box-shadow: 1px 1px 0 #000 }
.card .tools .dot { border-radius: 50%; background: var(--next) }
.card.editing { cursor: text; outline: 2px solid #2269ff; outline-offset: 1px }
.lifted { display: none !important }
.ghost { border: 1px dashed #000; border-radius: 2px; padding: 6px 8px 7px;
	background: repeating-linear-gradient(-45deg, #ff228414 0 6px, #fff0 6px 12px); color: #0005 }
.list.ghost { flex: 0 0 200px; border-radius: 6px; min-height: 120px; padding: 10px }
.float { position: fixed; z-index: 9; pointer-events: none; transform: rotate(3.5deg);
	box-shadow: 5px 7px 0 #000 !important; opacity: .96 }
.list.float { transform: rotate(2deg) }
.add { display: flex; flex-direction: column; gap: 6px }
.add textarea { font: inherit; resize: none; border: 1px solid #000; border-radius: 2px;
	padding: 5px 7px; outline: none; box-shadow: inset 1px 1px 0 #0002 }
.add .row { display: flex; gap: 6px; align-items: center }
.add .go { background: #ff2284; color: #fff; font-weight: 600 }
.add .open { text-align: left; border-style: dashed; box-shadow: none; background: none; width: 100% }
.add .open:hover { background: #fff8; box-shadow: none; transform: none }
.newlist { flex: 0 0 170px; background: #fff8; border: 1px dashed #000; border-radius: 6px;
	padding: 8px }
.newlist .open { border: 0 }
.list > header .h { padding: 0 4px; box-shadow: 1px 1px 0 #000; font-size: 11px; margin-left: auto }
.list > header .h + .x { margin-left: 0 }
.list.open, .card.open { outline: 3px solid #2269ff; outline-offset: 2px }
.board.drawn .lists { margin-right: 352px }
.drawer { position: fixed; z-index: 5; right: 12px; top: 54px; bottom: 12px; width: 340px;
	overflow-y: auto; background: #fff; border: 1px solid #000; border-radius: 6px;
	box-shadow: 0 0 10px 2px #66003322, 4px 4px 0 #000; padding: 8px 10px; display: flex;
	flex-direction: column; gap: 8px }
.drawer > header { display: flex; align-items: center; gap: 8px; position: sticky; top: -8px;
	background: #fff; padding: 2px 0 6px; border-bottom: 1px solid #000; z-index: 1 }
.drawer > header .tag { background: #2269ff; color: #fff }
.drawer > header b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.drawer > header .close { padding: 0 7px }
.drawer .none { color: #0008; margin: 4px 0 }
.drawer em { font-style: normal; font-weight: 600; background: #ffff88; padding: 0 2px }
.step { border: 1px solid #000; border-radius: 2px; padding: 5px 7px; background: #fffdf2 }
.step.done { opacity: .55 }
.step .line { display: flex; gap: 6px; align-items: baseline }
.step .no { font: 11px Monaco, ui-monospace, monospace; color: #2269ff; flex: none }
.step .meta { font-size: 11px; color: #0008; margin: 1px 0 4px 2px }
.step .acts { display: flex; gap: 6px }
.step .acts button { font-size: 12px; padding: 0 8px; box-shadow: 1px 1px 0 #000 }
.step .pre { margin-top: 6px; border-top: 1px dashed #000; padding-top: 5px; font-size: 13px }
.step .pre p { margin: 3px 0 }
.step .pre mark { background: #ff228433; font-weight: 600 }
.step .pre .how { font-size: 11px; color: #0009 }
.step .pre.nope { color: #c2005f; font-weight: 500 }
.step .pre .go { background: #ff2284; color: #fff; font-weight: 600 }
.burst { position: fixed; z-index: 10; pointer-events: none; font-size: 18px;
	animation: fly 900ms cubic-bezier(.2, .8, .3, 1) forwards }
@keyframes fly { to { transform: translate(var(--dx), var(--dy)) rotate(var(--r)); opacity: 0 } }
`

// the latest of these steps that took this key's node out of the board (into the trash)
const remover = (steps: Stp[], key: string) =>
	[...steps].reverse().find((s) =>
		s.writes.some((w) => w.kind === "moved" && w.key === key && inTrash(w.to!))
	)
const inTrash = (p: readonly string[]) => p[0] === TRASH[0] && p[1] === TRASH[1]

// the entries a rebased patch would take out or move are the ones its step put in or moved
function meant(list, x, w) {
	if (x.move) return list[x.move.range[0]] === w.moved
	if (!x.range || x.range[1] === x.range[0]) return true
	const put = w.redo.find((y) => y.path.length === 0 && Array.isArray(y.value))?.value
	if (!put) return true
	const out = list.slice(x.range[0], x.range[1])
	return out.length === put.length && out.every((e, i) => e === put[i])
}

// ---- rebase: an earlier change's inverse, carried through every change made after it ----
// op has invert (every change keeps its undo) but no rebase or transform: this is one, by hand,
// for the patches this board writes. a patch here is one of
//   whole: a put or a removal of what is at a path (no range)
//   range: [a, b) of the list or string at a path taken out, its value (if any) put there
//   move:  one item of a list taken out (move.range), put at range[0] counted without it
// through: the later changes, each a list of patches, in order. a later patch at the same path
// moves the positions after where it changed things; one that touched what the inverse touches is
// a conflict, thrown with the index of that later change
class Conflict extends Error {
	why: string
	at: number
	constructor(why, at) {
		super(why)
		this.why = why
		this.at = at
	}
}

// how many positions: a string's code points, a list's items
const size = (v) => (v === undefined ? 0 : typeof v === "string" ? [...v].length : v.length)
const starts = (long, short) => short.length <= long.length && short.every((k, i) => long[i] === k)

// a later patch as what it changed: spans of a list or string (from at, out taken out and put
// put in; a move is two), or the whole of a path
function spans(q) {
	if (q.move) {
		return [
			{ path: q.move.path, at: q.move.range[0], out: 1, put: 0 },
			{ path: q.path, at: q.range[0], out: 0, put: 1 },
		]
	}
	if (q.range) {
		return [{ path: q.path, at: q.range[0], out: q.range[1] - q.range[0], put: size(q.value) }]
	}
	return [{ path: q.path, whole: true }]
}

// a region [a, b) after a span changed the same list or string; a === b is a gap between two
// positions, and something put in right there goes after the gap
function shift([a, b], s) {
	const end = s.at + s.out, by = s.put - s.out
	if (a === b) {
		if (s.out === 0 && s.at === a) return [a, b]
		if (end <= a) return [a + by, b + by]
		if (s.at < a) throw "inside"
		return [a, b]
	}
	if (s.at < b && end > a) throw "overlap"
	if (s.out === 0 && s.at > a && s.at < b) throw "overlap"
	if (end <= a) return [a + by, b + by]
	return [a, b]
}

function rebase(patches, through) {
	return patches.map((p) => carry(p, through))
}

function carry(p, through) {
	const path = [...p.path]
	// what p touches at its path: a region; or for a move, its item and the gap it goes to,
	// counted with the item there
	let region = p.range && !p.move ? [...p.range] as [number, number] : undefined
	let item, gap
	if (p.move) {
		if (!same(p.move.path, p.path)) throw new Conflict("tangled", 0)
		item = [p.move.range[0], p.move.range[0] + 1]
		const g = p.range[0]
		gap = g <= item[0] ? [g, g] : [g + 1, g + 1]
	}
	through.forEach((q, at) => {
		for (const s of q.flatMap(spans)) {
			try {
				if (same(s.path, path)) {
					// the same list or string: what p touches moves, or was touched
					if (s.whole || (!region && !item)) throw "again"
					if (region) region = shift(region, s)
					else (item = shift(item, s), gap = shift(gap, s))
				} else if (starts(path, s.path)) {
					// it changed what holds what p touches: p's place in it moves
					if (s.whole) throw "again"
					const j = path[s.path.length]
					if (typeof j === "number") path[s.path.length] = shift([j, j + 1], s)[0]
				} else if (starts(s.path, path)) {
					// it changed something inside what p touches
					if (!region && !item) throw "again"
					const j = s.path[path.length]
					if (region && j >= region[0] && j < region[1]) throw "overlap"
				}
			} catch (why) {
				if (typeof why === "string") throw new Conflict(why, at)
				throw why
			}
		}
	})
	if (p.move) {
		const t = gap[0] <= item[0] ? gap[0] : gap[0] - 1
		return { path, range: [t, t], move: { path, range: item } }
	}
	return region ? { ...p, path, range: region } : { ...p, path }
}

const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])
const ghosted = (k: string) => k.startsWith("drag:")

// a write the history keeps: a value written to what a key names (its patches and their
// inverse), or a node moved from a path to another
type Write = {
	kind: "value" | "moved"
	key: string
	undo?: readonly Patch[]
	redo?: readonly Patch[]
	moved?: unknown
	from?: Names
	to?: Names
}
type Stp = {
	n: number
	words: string
	about: string[]
	undid?: number
	caller: string
	trusted: boolean
	time: number
	writes: Write[]
}
type History = { steps: Stp[]; at: number; count: number }
type Names = string[]
type Who = { caller: string; "trusted-event": boolean }

// the board is saved under ./board, its live elements under ./ui; the process is "trello" (a name
// of its own: a process shadows what is saved at its path). a folder is a node whose value is the
// order of its children's names and whose children are named by those names: lists under
// board/lists, a list's cards under its cards. a created node is named by its own id; a removed one
// is moved to board/trash, where it stays
const LISTS: Names = ["board", "lists"]
const TRASH: Names = ["board", "trash"]
const cardsOf = (list: string): Names => [...LISTS, list, "cards"]
const str = (p: Names) => "/" + p.join("/")

// the view's reconcile: take out only what is no longer wanted, move only what is out of place
function mount(parent: Element, next: Element[]) {
	const keep = new Set(next)
	for (const n of [...parent.children]) if (!keep.has(n)) n.remove()
	let before: Element | null = null
	for (let i = next.length - 1; i >= 0; i--) {
		const n = next[i]
		if (n.parentNode !== parent || n.nextElementSibling !== before) parent.insertBefore(n, before)
		before = n
	}
}

export default function program() {
	// what a node holds, as the board takes it (any: its values are its own). what the actions read
	// is untracked: each runs inside peep
	// deno-lint-ignore no-explicit-any
	const read = (x: Parameters<typeof readNode>[0]): any => readNode(x)

	// a live thing kept across reloads: saved under ./ui, made the first time only
	const keep = <T,>(name: string, make: () => T): T =>
		peep(() => readNode(ref(`./ui/${name}`, make))) as T
	// the look: a style element kept across reloads, its text set by every setup
	const style = keep("style", () => document.head.appendChild(document.createElement("style")))
	style.textContent = LOOK
	keep("font", () =>
		document.head.appendChild(Object.assign(document.createElement("link"), {
			rel: "stylesheet",
			href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap",
		})))

	// ---- the board
	const here = (p: Names) => hasNode(str(p))
	// a folder: a node whose value is the order of its children's names
	const folder = (p: Names) => ensureNode(str(p), [])
	const fresh = !here(LISTS)
	folder(LISTS)
	folder(TRASH)
	const history = ensureNode("./board/history", { steps: [], at: 0, count: 0 })
	// whose history is open: the board, a list or a card
	const drawing = ensureNode("./board/drawer", null)
	// the undo-just-one plan the drawer shows: { n, plan }
	const planned = ensureNode("./board/plan", null)

	// ---- where a thing is. a node is its path, so one that moves has another: a card is found by its
	// name in the lists, in the trash, or in a list that is in the trash. a key names what a write
	// was to, wherever it is now: "lists" (its order), "list:<id>" (its title), "cards:<id>" (that
	// list's order), "card:<id>" (a card)
	const order = (f: Names) => (here(f) ? read(str(f)) as string[] | undefined : undefined) ?? []
	const idsIn = (f: Names) => order(f).filter((k) => !ghosted(k))
	function listPath(l: string): Names | undefined {
		for (const p of [[...LISTS, l], [...TRASH, l]]) if (here(p)) return p
	}
	function cardPath(c: string): Names | undefined {
		for (const l of idsIn(LISTS)) {
			const p = [...cardsOf(l), c]
			if (here(p)) return p
		}
		if (here([...TRASH, c])) return [...TRASH, c]
		for (const l of peep(() => list(str(TRASH)))) {
			const p = [...TRASH, l, "cards", c]
			if (here(p)) return p
		}
	}
	function pathOf(key: string): Names | undefined {
		const [kind, id] = key.split(":")
		if (key === "lists") return LISTS
		if (kind === "list") return listPath(id)
		if (kind === "cards") {
			const p = listPath(id)
			return p && [...p, "cards"]
		}
		return cardPath(id)
	}
	const keyOfFolder = (f: Names) => str(f) === str(LISTS) ? "lists" : `cards:${f[2]}`

	// ---- what the graph says: a memo lands at stats
	const nameOf = (list: string) => {
		const p = listPath(list)
		return p && (read(str(p)) as string)
	}
	const textOf = (card: string) => {
		const p = cardPath(card)
		return p && (read(str(p)) as { text: string } | undefined)?.text
	}
	const listOf = (card: string) => idsIn(LISTS).find((l) => idsIn(cardsOf(l)).includes(card))
	const stats = createMemo("stats", () => {
		const lists = idsIn(LISTS)
		let cards = 0
		for (const l of lists) cards += idsIn(cardsOf(l)).length
		return `${cards} cards · ${lists.length} lists`
	})

	// ---- the undo history. every call that says what it did is a step: the writes it made to the
	// board, each a value written (its patches and their inverse: the change's op.undo, read as the
	// write lands) or a node moved from a path to another (a card to another list, a removal to the
	// trash, an add from it)
	let step: { writes: Write[]; words?: string; about?: string[]; undid?: number } | undefined
	// patches to what a key names, kept for the step going on
	function write(key: string, patches: Patch[]) {
		const p = pathOf(key)
		if (!p) throw new Error(`nothing at ${key}`)
		patch(str(p), patches)
		if (!step) return
		const op = (change(str(p)) as { op?: { patches: readonly Patch[]; undo: readonly Patch[] } })
			?.op
		if (!op) return
		const w: Write = { kind: "value", key, undo: op.undo, redo: op.patches }
		const m = op.patches.find((x) => x.move)
		const v = read(str(p))
		if (m && Array.isArray(v)) w.moved = v[m.range![0]]
		step.writes.push(w)
	}
	// a node to another path (rename: one change over the two folders), kept for the step
	function relocate(key: string, from: Names, to: Names) {
		rename(str(from), str(to))
		step?.writes.push({ kind: "moved", key, from, to })
	}
	// the id in at index of a folder's order, or out
	function put(f: Names, id: string, index?: number) {
		const at = Math.min(index ?? order(f).length, order(f).length)
		write(keyOfFolder(f), [{ path: [], range: [at, at], value: [id] }])
	}
	function cut(f: Names, id: string) {
		const at = order(f).indexOf(id)
		if (at >= 0) write(keyOfFolder(f), [{ path: [], range: [at, at + 1] } as Patch])
	}
	// a new node, named by its own id: made in the trash and moved into the folder, its id in the
	// order at index (the end), so an add is a move like any other and its undo puts it back
	function add(f: Names, kind: "card" | "list", value: unknown, index?: number): string {
		const id = crypto.randomUUID()
		ensureNode(str([...TRASH, id]), value)
		relocate(`${kind}:${id}`, [...TRASH, id], [...f, id])
		put(f, id, index)
		return id
	}
	// the child out of the folder and out of its order: moved to the trash, its node and what is
	// under it kept there
	function take(f: Names, kind: "card" | "list", id: string) {
		relocate(`${kind}:${id}`, [...f, id], [...TRASH, id])
		cut(f, id)
	}
	// the child out of the folder from, into the folder to at index k (counted without it): in the
	// same folder only its place in the order changes; else the node moves, and keeps its name
	function shove(from: Names, kind: "card" | "list", id: string, to: Names, k: number) {
		if (str(from) === str(to)) {
			const f = order(from).indexOf(id)
			if (f < 0 || f === k) return
			write(keyOfFolder(from), [{
				path: [],
				range: [k, k],
				move: { path: [], range: [f, f + 1] },
			}])
			return
		}
		relocate(`${kind}:${id}`, [...from, id], [...to, id])
		cut(from, id)
		put(to, id, k)
	}

	// the drag layer: the dragged node placed in the folder under "drag:<id>", and that name in
	// its order at index. one at a time; not on the history
	let ghost: { folder: Names; id: string } | undefined
	function where() {
		if (!ghost) return
		const index = order(ghost.folder).indexOf("drag:" + ghost.id)
		return index < 0 ? undefined : { ...ghost, index }
	}
	function unghost() {
		const g = where()
		ghost = undefined
		if (!g) return
		const name = "drag:" + g.id
		unplace(`${str(g.folder)}/${name}`)
		const at = order(g.folder).indexOf(name)
		if (at >= 0) patch(str(g.folder), [{ path: [], range: [at, at + 1] } as Patch])
	}
	function ghostAt(f: Names, id: string, index: number) {
		unghost()
		const at = pathOf(str(f) === str(LISTS) ? `list:${id}` : `card:${id}`)!
		place(`${str(f)}/drag:${id}`, str(at))
		const i = Math.min(index, order(f).length)
		patch(str(f), [{ path: [], range: [i, i], value: ["drag:" + id] }])
		ghost = { folder: f, id }
	}

	// a step recorded: what came after the step it is at goes
	function remember(s: NonNullable<typeof step>, by: Who) {
		const { steps, at, count } = read(history) as History
		const entry: Stp = {
			n: count + 1,
			words: s.words!,
			about: s.about ?? [],
			undid: s.undid,
			caller: by.caller,
			trusted: by["trusted-event"],
			time: Date.now(),
			writes: s.writes,
		}
		patch(history, [
			{ path: ["steps"], range: [at, steps.length], value: [entry] },
			{ path: ["at"], value: at + 1 },
			{ path: ["count"], value: count + 1 },
		])
	}
	// undo, redo: a step's inverses applied newest first, or its patches again oldest first; a move
	// the other way, or again
	function travel(by: number) {
		const { steps, at } = read(history) as History
		const s = by < 0 ? steps[at - 1] : steps[at]
		if (!s) return
		const writes = by < 0 ? [...s.writes].reverse() : s.writes
		for (const w of writes) {
			if (w.kind === "moved") {
				if (by < 0) rename(str(w.to!), str(w.from!))
				else rename(str(w.from!), str(w.to!))
			} else patch(str(pathOf(w.key)!), [...(by < 0 ? w.undo! : w.redo!)])
		}
		patch(history, [{ path: ["at"], value: at + by }])
	}

	// undo just step n: what it would do (nothing written), as per node patches carried through
	// every later change to it; or why it can't: gone (the node is not on the board now), again (a
	// later change set the same thing), overlap, inside (a later change touched the same items or
	// words), lost; by: that later step
	// deno-lint-ignore no-explicit-any
	function plan(n: number): any {
		const { steps, at } = read(history) as History
		const k = steps.findIndex((x) => x.n === n)
		if (k < 0 || k >= at) return { ok: false, why: "undone" }
		const s = steps[k], later = steps.slice(k + 1, at)
		// deno-lint-ignore no-explicit-any
		const out: any[] = []
		for (let i = s.writes.length - 1; i >= 0; i--) {
			const w = s.writes[i]
			const no = (why: string, by?: Stp) => ({
				ok: false,
				why,
				key: w.key,
				kind: w.kind,
				step: s,
				by,
			})
			if (w.kind === "moved") {
				// a move undone puts the node back where it came from: it has to be where the move left it,
				// and no later change moved or removed it
				for (const l of later) {
					if (l.writes.some((x) => x.kind === "moved" && x.key === w.key)) {
						return no("overlap", l)
					}
				}
				if (!here(w.to!)) return no("gone", remover(later, w.key))
				out.push({ kind: "moved", key: w.key, from: w.to, to: w.from, later: 0 })
				continue
			}
			const mine = (x: Write) => x.kind === "value" && x.key === w.key
			const p = pathOf(w.key)
			if (!p || inTrash(p)) return no("gone", remover(later, w.key))
			// everything that changed this node after w, in order: the rest of its step, the steps
			// after it, and the inverses already worked out here
			const through: (readonly Patch[])[] = [], whose: Stp[] = []
			for (const x of s.writes.slice(i + 1)) if (mine(x)) (through.push(x.redo!), whose.push(s))
			for (const l of later) {
				for (const x of l.writes) if (mine(x)) (through.push(x.redo!), whose.push(l))
			}
			for (const o of out) {
				if (o.kind === "value" && o.key === w.key) (through.push(o.patches), whose.push(s))
			}
			let rebased: Patch[]
			try {
				rebased = rebase(w.undo!, through)
			} catch (e) {
				if (e instanceof Conflict) return no(e.why, whose[e.at])
				throw e
			}
			// on the value as it is now: the entries it takes out or moves must be the ones it means
			const before = read(str(p))
			let v = before
			const patches: Patch[] = []
			try {
				for (const x of rebased) {
					if (Array.isArray(v) && !meant(v, x, w)) return no("lost")
					v = apply(v, [x])
					patches.push(x)
				}
			} catch {
				return no("lost")
			}
			const moved = JSON.stringify(rebased) !== JSON.stringify(w.undo)
			out.push({
				kind: "value",
				key: w.key,
				patches,
				before,
				after: v,
				later: through.length,
				moved,
			})
		}
		return { ok: true, step: s, writes: out }
	}

	// ---- handlers: every write is a call (a click has no scope open), every call that says what it
	// did an undo step. act: an action that keeps its writes for the step, and puts it on the history
	// when it said (say) what it did. each runs untracked (peep: its reads are for now)
	const say = (words: string, ...about: (string | undefined)[]) => {
		if (step) (step.words = words, step.about = about.filter(Boolean) as string[])
	}
	function act(name: string, fn: (...a: any[]) => unknown, steps = true) {
		createAction(`on/${name}`, (...a: unknown[]) =>
			peep(() => {
				const was = step
				if (steps) step = { writes: [] }
				try {
					return fn(...a)
				} finally {
					const done = step
					step = was
					if (steps && done?.words && done.writes.length) remember(done, who())
				}
			}))
	}
	// the page calls an action by name: nothing is open in a plain listener (the elements here are
	// built by hand), so the board's events are heard once, on its root, and each says its call
	createAction("on/do", (name: string, ...args: unknown[]) => executeAction(`on/${name}`, ...args))
	act("add-card", (list: string, text: string) => {
		const card = add(cardsOf(list), "card", { text, tint: "none" })
		say(`added ${em(text)} to ${em(nameOf(list))}`, list, card)
	})
	// an edit is a splice: only the words that changed
	act("edit-card", (card: string, text: string) => {
		const was = textOf(card)!
		const [at, out, put] = differ(was, text) as [number, number, string]
		write(`card:${card}`, [
			put ? { path: ["text"], range: [at, at + out], value: put } : {
				path: ["text"],
				range: [at, at + out],
			} as Patch,
		])
		say(`changed ${em(was)} to ${em(text)}`, card, listOf(card))
	})
	act("tint", (card: string) => {
		const p = cardPath(card)!
		const was = (read(str(p)) as { tint: string }).tint
		const next = TINTS[(TINTS.indexOf(was) + 1) % TINTS.length]
		write(`card:${card}`, [{ path: ["tint"], value: next }])
		say(
			next === "none"
				? `took the colour off ${em(textOf(card))}`
				: `coloured ${em(textOf(card))} ${next}`,
			card,
			listOf(card),
		)
	})
	act("remove-card", (list: string, card: string) => {
		take(cardsOf(list), "card", card)
		say(`removed ${em(textOf(card))} from ${em(nameOf(list))}`, card, list)
	})
	act("add-list", (text: string) => {
		const list = add(LISTS, "list", text)
		folder(cardsOf(list))
		say(`added the list ${em(text)}`, list)
	})
	act("rename-list", (list: string, text: string) => {
		const was = nameOf(list)!
		const [at, out, put] = differ(was, text) as [number, number, string]
		write(`list:${list}`, [
			put ? { path: [], range: [at, at + out], value: put } : {
				path: [],
				range: [at, at + out],
			} as Patch,
		])
		say(`renamed the list ${em(was)} to ${em(text)}`, list)
	})
	// a list goes with its cards still under it: undo places it back whole
	act("remove-list", (list: string) => {
		take(LISTS, "list", list)
		say(`removed the list ${em(nameOf(list))}`, list)
	})
	// the drag layer: the drop spot for what is dragged, k places in among the others
	act("hover", (kind: string, list: string, k: number, id: string) => {
		const f = kind === "card" ? cardsOf(list) : LISTS
		unghost()
		const all = order(f)
		const others = all.filter((x) => x !== id)
		ghostAt(f, id, k < others.length ? all.indexOf(others[k]) : all.length)
	})
	act("move", (kind: "card" | "list", from: string, id: string) => {
		const g = where()
		if (!g) return
		// the place among the others: what the ghost had before it, the dragged one not counted
		const k = order(g.folder).filter((x, j) => !ghosted(x) && x !== id && j < g.index).length
		unghost()
		const source = kind === "card" ? cardsOf(from) : LISTS
		const i = idsIn(source).indexOf(id)
		shove(source, kind, id, g.folder, k)
		if (kind === "list") {
			return say(`moved the list ${em(nameOf(id))} from place ${i + 1} to ${k + 1}`, id)
		}
		const into = idsIn(LISTS).find((l) => str(cardsOf(l)) === str(g.folder))!
		say(
			into === from
				? `moved ${em(textOf(id))} in ${em(nameOf(from))} from place ${i + 1} to ${k + 1}`
				: `moved ${em(textOf(id))} from ${em(nameOf(from))} to ${em(nameOf(into))}`,
			id,
			from,
			into,
		)
	})
	// what undoing just step n would do, for the drawer to show: worked out, or why not (nothing is
	// written but this)
	act(
		"plan",
		(n: number | null) =>
			patch(planned, [{ path: [], value: n === null ? null : { n, plan: plan(n) } }]),
		false,
	)
	// undo just step n: worked out, or why not; done, it is a step of its own, which says it undid
	act("revert", (n: number) => {
		unghost()
		const r = plan(n)
		if (!r.ok) return patch(planned, [{ path: [], value: { n, plan: r } }])
		for (const w of r.writes) {
			if (w.kind === "moved") relocate(w.key, w.from, w.to)
			else write(w.key, w.patches)
		}
		if (step) step.undid = n
		say(`undid #${n}: ${r.step.words}`, ...r.step.about)
		patch(planned, [{ path: [], value: null }])
	})
	act(
		"open",
		(kind: string | null, id: string) =>
			patch(drawing, [{ path: [], value: kind ? { kind, id } : null }]),
		false,
	)
	act("cancel", () => unghost(), false)
	act("undo", () => (unghost(), travel(-1)), false)
	act("redo", () => (unghost(), travel(1)), false)

	// the first time only: the board seeded
	if (fresh) {
		for (const [title, cards] of SEED) {
			const list = add(LISTS, "list", title)
			folder(cardsOf(list))
			for (const [text, tint] of cards) add(cardsOf(list), "card", { text, tint })
		}
	}

	// ---- the view
	const view = keep(
		"view",
		() => Object.assign(document.createElement("div"), { className: "board" }),
	)
	const top = keep(
		"top",
		() => Object.assign(document.createElement("div"), { className: "top" }),
	)
	const title = keep(
		"title",
		() => Object.assign(document.createElement("span"), { className: "tag title" }),
	)
	title.textContent = "🍋 the board"
	const tag = keep(
		"stats",
		() => Object.assign(document.createElement("span"), { className: "tag stats" }),
	)
	createEffect("summary", () => read(stats), (v) => {
		tag.textContent = v == null ? "" : String(v)
	})
	const undo = keep("undo", () => document.createElement("button"))
	const redo = keep("redo", () => document.createElement("button"))
	undo.dataset.do = "undo"
	redo.dataset.do = "redo"
	const fill = keep(
		"fill",
		() => Object.assign(document.createElement("span"), { className: "fill" }),
	)
	const all = keep("all", () => document.createElement("button"))
	all.textContent = "🕘 history"
	all.dataset.do = "open-board"
	mount(top, [title, tag, fill, all, undo, redo])
	createEffect("buttons", () => {
		const { steps, at } = read(history) as History
		return [at, steps.length, steps[at - 1]?.words ?? "", steps[at]?.words ?? ""] as [
			number,
			number,
			string,
			string,
		]
	}, ([at, n, back, forth]) => {
		const short = (w: string) =>
			(w = w.replaceAll("*", "")).length > 26 ? w.slice(0, 25) + "…" : w
		undo.textContent = `↶ undo${at ? `: ${short(back)}` : ""}`
		redo.textContent = `↷ redo${at < n ? `: ${short(forth)}` : ""}`
		undo.title = back.replaceAll("*", "")
		redo.title = forth.replaceAll("*", "")
		undo.disabled = at === 0
		redo.disabled = at >= n
	}, { equal: same })
	const lists = keep(
		"columns-box",
		() => Object.assign(document.createElement("div"), { className: "lists" }),
	)
	const newlist: any = keep("newlist", () => adder("+ add a list", "list title"))
	newlist.classList.add("newlist")

	// the columns: one per id in board/lists' order, a ghost column where a dragged list would go
	createEffect("columns", () => [...order(LISTS)], (keys) => {
		mount(lists, [...keys.map((k) => column(k)), newlist])
	}, { equal: same })

	function column(k: string) {
		const id = k.replace(/^drag:/, "")
		if (ghosted(k)) {
			const g = keep(
				"ghostlist",
				() => Object.assign(document.createElement("div"), { className: "list ghost" }),
			)
			g.textContent = nameOf(id) ?? ""
			return g
		}
		const col = keep("list-" + id, () => {
			const el = Object.assign(document.createElement("section"), { className: "list" })
			el.innerHTML =
				`<header><span class="tag name"></span><span class="count"></span><button class="h" title="this list's history">🕘</button><button class="x" title="remove the list">×</button></header><div class="cards"></div>`
			el.append(adder("+ add a card", "what needs doing?"))
			return el
		})
		col.dataset.list = id
		const name = col.querySelector(".name") as HTMLElement
		const count = col.querySelector(".count") as HTMLElement
		const cards = col.querySelector(".cards") as HTMLElement
		editable(name)
		createEffect(`title-${id}`, () => read(str([...LISTS, id])) as string, (v) => {
			name.dataset.was = v
			if (document.activeElement !== name) name.textContent = v
		})
		createEffect(`size-${id}`, () => [...order(cardsOf(id))], (keys) => {
			count.textContent = String(keys.filter((k) => !ghosted(k)).length)
			mount(cards, keys.map((k) => card(k, id)))
		}, { equal: same })
		return col
	}

	function card(k: string, list: string) {
		const id = k.replace(/^drag:/, "")
		if (ghosted(k)) {
			const g = keep(
				"ghostcard",
				() => Object.assign(document.createElement("div"), { className: "ghost" }),
			)
			g.textContent = textOf(id) ?? ""
			return g
		}
		const el = keep("card-" + id, () => {
			const el = Object.assign(document.createElement("div"), { className: "card" })
			el.innerHTML =
				`<span class="text"></span><span class="tools"><button class="x" title="remove">×</button><button class="dot" title="next colour"></button><button class="h" title="this card's history">🕘</button></span>`
			return el
		})
		el.dataset.card = id
		el.dataset.list = list
		const text = el.querySelector(".text") as HTMLElement

		editable(text)
		createEffect(
			`draw-${id}`,
			() => read(str([...cardsOf(list), id])) as { text: string; tint: string },
			(v) => {
				text.dataset.was = v.text
				if (document.activeElement !== text) text.textContent = v.text
				el.dataset.tint = v.tint
				const next = TINTS[(TINTS.indexOf(v.tint) + 1) % TINTS.length]
				el.style.setProperty(
					"--next",
					next === "none" ? "#fff" : `var(--${next}, ${tint(next)})`,
				)
			},
		)
		return el
	}

	// ---- the history drawer: the steps that touched what is open, newest first. each can be
	// undone alone: first what it would do (or why it can't), then, asked, done
	const drawer = keep(
		"drawer",
		() => Object.assign(document.createElement("aside"), { className: "drawer" }),
	)
	createEffect("panel", () => {
		const o = read(drawing) as { kind: string; id: string } | null
		if (!o) return null
		const { steps, at } = read(history) as History
		const applied = steps.slice(0, at)
		const undone = new Set(applied.map((x) => x.undid).filter(Boolean))
		const name = o.kind === "board"
			? "the board"
			: o.kind === "list"
			? nameOf(o.id)
			: textOf(o.id)
		const rows = applied.filter((x) =>
			o.kind === "board" || x.about?.includes(o.id) ||
			x.writes.some((w) => w.key === `${o.kind}:${o.id}`) ||
			(o.kind === "list" && x.writes.some((w) => w.key === `cards:${o.id}`))
		).reverse()
		return { o, name, rows, undone, shown: read(planned) as { n: number; plan: any } | null }
	}, (v) => {
		drawer.hidden = !v
		view.classList.toggle("drawn", !!v)
		lists.querySelectorAll(".list.open").forEach((l) => l.classList.remove("open"))
		lists.querySelectorAll(".card.open").forEach((c) => c.classList.remove("open"))
		if (!v) return
		lists.querySelector(`[data-${v.o.kind}="${v.o.id}"]`)?.classList.add("open")
		drawer.innerHTML =
			`<header><span class="tag">🕘 ${v.o.kind === "board" ? "everything" : v.o.kind}</span><b>${
				esc(v.name ?? "")
			}</b><button class="close" title="close">×</button></header>` +
			(v.rows.length ? "" : `<p class="none">nothing has happened to it yet</p>`)
		for (const x of v.rows) {
			drawer.append(row(x, v.undone.has(x.n), v.shown?.n === x.n ? v.shown.plan : undefined))
		}
	})

	// a step of the history: its words, and the plan for undoing just it when it was asked for (the
	// buttons are heard on the root: undo just this, never mind, undo it)
	function row(x: Stp, done: boolean, plan_?: any) {
		const r = Object.assign(document.createElement("div"), {
			className: "step" + (done ? " done" : ""),
		})
		r.dataset.step = String(x.n)
		const when = new Date(x.time).toLocaleTimeString()
		r.innerHTML = `<div class="line"><span class="no">#${x.n}</span><span>${
			x.trusted ? "you" : esc(x.caller) + " (a script)"
		} ${words(x.words)}</span></div><div class="meta">${when}${
			done ? " · undone since" : ""
		}</div><div class="acts"><button class="one">undo just this</button></div><div class="pre" hidden></div>`
		const pre = r.querySelector(".pre") as HTMLElement
		const one = r.querySelector(".one") as HTMLElement
		if (!plan_) return r
		pre.hidden = false
		one.hidden = true
		if (!plan_.ok) {
			pre.className = "pre nope"
			pre.innerHTML = `can't undo ${words(x.words)}: ${
				why(plan_)
			}<div class="acts"><button class="nm">ok</button></div>`
		} else {
			pre.className = "pre yes"
			const later = Math.max(...plan_.writes.map((w: any) => w.later))
			const moved = plan_.writes.some((w: any) => w.moved)
			pre.innerHTML = `<b>it would:</b>` + plan_.writes.map(change_).join("") +
				`<p class="how">${
					later
						? `carried through ${later} later change${later > 1 ? "s" : ""}${
							moved ? ": its places moved" : ""
						}`
						: "nothing changed it since"
				}</p><div class="acts"><button class="go">undo it</button><button class="nm">never mind</button></div>`
		}
		return r
	}

	// a node's value now and after, in words: a list's cards in order, a card's words and colour,
	// a list's title
	function change_(w: any) {
		// a node moved is shown by the orders it changed
		if (w.kind === "moved") return ""
		if (Array.isArray(w.after)) {
			const board = w.key === "lists"
			const names = (v: string[] | undefined) => (v ?? []).filter((k) => !ghosted(k))
			const name = (id: string) => esc((board ? nameOf(id) : textOf(id)) ?? "?")
			// the ids its patches put in, take out or move: those are marked
			const touched = new Set()
			const list = w.before ?? []
			for (const x of w.patches) {
				if (x.move) touched.add(list[x.move.range[0]])
				else if (x.range) {
					list.slice(x.range[0], x.range[1]).forEach((e: string) => touched.add(e))
				}
				if (Array.isArray(x.value)) x.value.forEach((e: string) => touched.add(e))
			}
			const mark = (ids: string[]) =>
				ids.map((id) => touched.has(id) ? `<mark>${name(id)}</mark>` : name(id)).join(", ") ||
				"<i>none</i>"
			const owner = board ? "the lists" : nameOf(w.key.slice("cards:".length)) ?? "a list"
			return `<p><em>${board ? owner : esc(owner)}</em>: ${mark(names(w.before))} → ${
				mark(names(w.after))
			}</p>`
		}
		if (typeof w.after === "string") {
			return `<p>the list <em>${esc(w.before)}</em> → <em>${esc(w.after)}</em></p>`
		}
		const out = []
		if (w.before?.text !== w.after?.text) {
			out.push(`<em>${esc(w.before.text)}</em> → <em>${esc(w.after.text)}</em>`)
		}
		if (w.before?.tint !== w.after?.tint) out.push(`colour ${w.before.tint} → ${w.after.tint}`)
		return `<p>${out.join("; ")}</p>`
	}

	// why a step can't be undone alone, in words
	function why(plan: any) {
		const then = plan.by
			? ` (then ${plan.by.trusted ? "you" : plan.by.caller} ${
				words(plan.by.words)
			}, #${plan.by.n})`
			: ""
		const kind = String(plan.key).split(":")[0]
		const id = String(plan.key).split(":")[1]
		const card = kind === "card"
		const order = kind === "lists" || kind === "cards"
		if (plan.why === "undone") return "it is not on the history now"
		if (plan.why === "gone") {
			return card
				? `<em>${esc(textOf(id) ?? "")}</em> was removed after${then}`
				: order
				? `the list was removed after${then}`
				: `the list <em>${esc(nameOf(id) ?? "")}</em> was removed after${then}`
		}
		if (plan.why === "again") return `it was changed again after${then}`
		if (plan.why === "overlap" || plan.why === "inside") {
			return order || plan.kind === "moved"
				? `a later change moved or removed the same card${then}`
				: `a later change edited the same words${then}`
		}
		return "the list is not as its history says (something changed it off the record)"
	}

	mount(view, [top, lists, drawer])
	addTeardown((why) => why === "ended" && view.remove())

	// ---- the events. the board's elements are built by hand and nothing is open in a plain listener to
	// call an action from, so the board is one jsx root, and every event that calls is heard there
	// (bubbling, or the pointer kept by capture while one is dragged): each reads what it hit and
	// says the call it makes (on/do: name, ...args), or none. what only moves the page (opening an
	// adder, starting an edit) keeps its own listener
	let root!: HTMLElement
	const nearest = (e: Event, q: string) =>
		(e.target as HTMLElement).closest(q) as HTMLElement | null

	// "+ add a card": the text in the adder's textarea, cleared, as the call for that adder (a card
	// in its list, or a list)
	function added(box: HTMLElement) {
		const area = box.querySelector("textarea") as HTMLTextAreaElement
		const text = area.value.trim()
		area.value = ""
		area.focus()
		if (!text) return
		const col = box.closest(".list[data-list]") as HTMLElement | null
		return col ? ["add-card", col.dataset.list, text] : ["add-list", text]
	}
	const onClick = (e: MouseEvent) => {
		const b = nearest(e, "button")
		if (!b) return
		const col = b.closest(".list[data-list]") as HTMLElement | null
		const card = b.closest(".card") as HTMLElement | null
		const step = b.closest(".step") as HTMLElement | null
		const box = b.closest(".add") as HTMLElement | null
		if (b.dataset.do === "undo" || b.dataset.do === "redo") return [b.dataset.do]
		if (b.dataset.do === "open-board") return ["open", "board", "board"]
		if (box) return b.classList.contains("go") ? added(box) : undefined
		if (card) {
			const id = card.dataset.card
			if (b.classList.contains("x")) return ["remove-card", card.dataset.list, id]
			if (b.classList.contains("dot")) return ["tint", id]
			if (b.classList.contains("h")) return ["open", "card", id]
		} else if (col && b.closest("header")) {
			if (b.classList.contains("x")) return ["remove-list", col.dataset.list]
			if (b.classList.contains("h")) return ["open", "list", col.dataset.list]
		}
		if (b.classList.contains("close")) return ["open", null]
		if (step) {
			const n = Number(step.dataset.step)
			if (b.classList.contains("one")) return ["plan", n]
			if (b.classList.contains("nm")) return ["plan", null]
			if (b.classList.contains("go")) return ["revert", n]
		}
	}
	// enter in an adder adds; ⌘Z and ⇧⌘Z undo and redo; escape lets go of a drag
	const onKey = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement
		if (e.key === "Enter" && !e.shiftKey && t.tagName === "TEXTAREA") {
			const box = t.closest(".add") as HTMLElement | null
			if (box) return (e.preventDefault(), added(box))
		}
		if (e.key === "Escape" && drag?.float) return finish(e, false)
		if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return
		if (t.isContentEditable || t.tagName === "TEXTAREA") return
		e.preventDefault()
		return [e.shiftKey ? "redo" : "undo"]
	}
	// an edit in place ends when it loses the focus: kept if it changed and is not empty, else put back
	const onOut = (e: FocusEvent) => {
		const t = e.target as HTMLElement
		if (t.contentEditable !== "true") return
		t.contentEditable = "false"
		const card = t.closest(".card") as HTMLElement | null
		;(card ?? t).classList.remove("editing")
		const v = (t.textContent ?? "").trim()
		const was = t.dataset.was ?? ""
		if (!v || v === was) return void (t.textContent = was)
		return card
			? ["edit-card", card.dataset.card, v]
			: ["rename-list", (t.closest(".list[data-list]") as HTMLElement).dataset.list, v]
	}

	// the DOM side of a drag: a float follows the pointer; the drop spot is the graph's (a hover call
	// places the ghost), so the lists draw it like any entry
	type Drag = {
		kind: "card" | "list"
		el: HTMLElement
		source: string | null
		id: string
		down: PointerEvent
		box: DOMRect
		float?: HTMLElement
		last: string
		into?: string | null
	}
	let drag: Drag | undefined
	const onDown = (e: PointerEvent) => {
		if (e.button !== 0 || nearest(e, "button,[contenteditable=true],textarea")) return
		const head = nearest(e, ".list > header")
		const card = nearest(e, ".card")
		const el = head ? head.parentElement! : card
		if (!el || el.classList.contains("ghost")) return
		drag = {
			kind: head ? "list" : "card",
			el,
			source: head ? null : el.dataset.list!,
			id: head ? el.dataset.list! : el.dataset.card!,
			down: e,
			box: el.getBoundingClientRect(),
			last: "",
		}
	}
	const onMove = (e: PointerEvent) => {
		const d = drag
		if (!d) return
		if (!d.float) {
			if (Math.hypot(e.clientX - d.down.clientX, e.clientY - d.down.clientY) < 5) return
			d.float = d.el.cloneNode(true) as HTMLElement
			d.float.classList.add("float")
			d.float.style.width = d.box.width + "px"
			document.body.append(d.float)
			d.el.classList.add("lifted")
			// from here the pointer is the root's, wherever it goes (a mount moving the dragged element
			// would otherwise drop it)
			root.setPointerCapture(d.down.pointerId)
		}
		d.float.style.left = e.clientX - (d.down.clientX - d.box.left) + "px"
		d.float.style.top = e.clientY - (d.down.clientY - d.box.top) + "px"
		const spot = spotAt(d.kind, e.clientX, e.clientY, d.id)
		if (spot && spot.join() !== d.last) {
			d.last = spot.join()
			d.into = spot[0] as string | null
			return ["hover", d.kind, spot[0], spot[1], d.id]
		}
	}
	const finish = (e: PointerEvent | KeyboardEvent, drop: boolean) => {
		const d = drag
		drag = undefined
		if (!d?.float) return
		d.float.remove()
		d.el.classList.remove("lifted")
		if (!drop) return ["cancel"]
		// a card dropped into the list called done, from another: a burst (DOM only)
		const into = d.into ? lists.querySelector(`[data-list="${d.into}"]`) : undefined
		if (
			d.kind === "card" && d.into !== d.source &&
			/done/i.test(into?.querySelector(".name")?.textContent ?? "")
		) {
			const at = e as PointerEvent
			burst(at.clientX, at.clientY)
		}
		return ["move", d.kind, d.source, d.id]
	}

	// where a drop would land: [list id, place among the others], or [null, place] for a list
	function spotAt(kind: string, x: number, y: number, id: string) {
		if (kind === "list") {
			const cols = [...lists.querySelectorAll(":scope > .list:not(.ghost):not(.lifted)")]
			return [
				null,
				cols.filter((c) => {
					const r = c.getBoundingClientRect()
					return r.left + r.width / 2 < x
				}).length,
			]
		}
		const col = document.elementFromPoint(x, y)?.closest(".list:not(.ghost)") as HTMLElement
		if (!col?.dataset.list) return
		const cards = [...col.querySelectorAll(".card:not(.lifted)")].filter((c) =>
			(c as HTMLElement).dataset.card !== id
		)
		return [
			col.dataset.list,
			cards.filter((c) => {
				const r = c.getBoundingClientRect()
				return r.top + r.height / 2 < y
			}).length,
		]
	}

	// double-click to edit in place: enter keeps it, escape puts it back (what it was is the
	// element's data-was; the root hears it lose the focus and says the call)
	function editable(el: HTMLElement) {
		const frame = el.classList.contains("text") ? el.closest(".card") as HTMLElement : el
		frame.ondblclick = () => {
			el.contentEditable = "true"
			frame.classList.add("editing")
			el.focus()
			getSelection()!.selectAllChildren(el)
		}
		el.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), el.blur())
			if (e.key === "Escape") (el.textContent = el.dataset.was ?? "", el.blur())
		}
	}

	// "+ add a card": a button that opens into a textarea; enter or add (the root hears them) adds
	// and stays open
	function adder(label: string, hint: string) {
		const el = Object.assign(document.createElement("div"), { className: "add" }) as HTMLElement
		const open = Object.assign(document.createElement("button"), {
			className: "open",
			textContent: label,
		})
		const area = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: hint })
		const row = Object.assign(document.createElement("div"), { className: "row" })
		const go = Object.assign(document.createElement("button"), {
			className: "go",
			textContent: "add",
		})
		const no = Object.assign(document.createElement("button"), { textContent: "×" })
		row.append(go, no)
		const show = (on: boolean) => {
			open.hidden = on
			area.hidden = row.hidden = !on
			if (on) area.focus()
		}
		open.onclick = () => show(true)
		no.onclick = () => show(false)
		area.onkeydown = (e) => {
			if (e.key === "Escape") show(false)
		}
		el.append(open, area, row)
		show(false)
		return el
	}

	const onStage = (f: (e: any) => unknown[] | undefined | void) => handler("on/do", f as never)
	return (
		<div
			class="root"
			tabIndex={-1}
			ref={(e) => {
				root = e as HTMLElement
				root.focus({ preventScroll: true })
			}}
			onClick={onStage(onClick)}
			onKeyDown={onStage(onKey)}
			onFocusOut={onStage(onOut)}
			onPointerDown={onStage(onDown)}
			onPointerMove={onStage(onMove)}
			onPointerUp={onStage((e) => finish(e, true))}
			onPointerCancel={onStage((e) => finish(e, false))}
		>
			{view}
		</div>
	)
}

// a name in words: *like this*
const em = (s) => `*${String(s ?? "").replaceAll("*", "∗")}*`
const esc = (s) =>
	String(s).replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	)
// words with *names* as html
const words = (w) => esc(w ?? "").replace(/\*([^*]*)\*/g, "<em>$1</em>")
// the one span that differs between two strings, in code points: where, how many out, what in
function differ(a, b) {
	const x = [...a], y = [...b]
	let i = 0
	while (i < x.length && i < y.length && x[i] === y[i]) i++
	let j = 0
	while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++
	return [i, x.length - i - j, y.slice(i, y.length - j).join("")]
}

const tint = (name) =>
	({ cherry: "#ff2284", mint: "#40dcba", blue: "#2269ff", lemon: "#ffff88" })[name]

// a little burst of joy when a card lands in done (DOM only: nothing in the graph)
function burst(x, y) {
	for (let i = 0; i < 14; i++) {
		const b = Object.assign(document.createElement("span"), {
			className: "burst",
			textContent: ["🍒", "✨", "🌸", "🍋", "⭐"][i % 5],
		})
		const a = (i / 14) * Math.PI * 2
		b.style.cssText = `left:${x - 9}px;top:${y - 12}px;--dx:${Math.cos(a) * 90}px;--dy:${
			Math.sin(a) * 90 - 30
		}px;--r:${(Math.random() - 0.5) * 360}deg`
		document.body.append(b)
		setTimeout(() => b.remove(), 950)
	}
}
