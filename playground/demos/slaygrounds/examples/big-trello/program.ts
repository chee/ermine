import type { API, Node } from "@ermine/api"
import apply, { type Patch } from "@ermine/op/apply"

// big-trello: a board. lists are nodes under board/lists, cards nodes under each list's cards,
// each named by its own id; the order is a value of its own: board/lists and every cards node
// hold the array of their children's ids. a drag is places' own move (a card to another list; in
// one list only the order changes), so a card keeps its node and its id wherever it goes. while
// you drag, the drop spot is in the graph too: the card's id placed in the list it hovers under
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

// the latest of these steps that took an entry with this id out of a list
const remover = (steps, id) =>
	[...steps].reverse().find((s) =>
		s.writes.some((w) =>
			w.undo.some((x) => x.value === id || (Array.isArray(x.value) && x.value.includes(id)))
		)
	)

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

// a write the history keeps: the node (its table id, and which part), the patches and their inverse
type Write = {
	part: "value" | "children"
	id: string
	undo: readonly Patch[]
	redo: readonly Patch[]
	moved?: unknown
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
type Who = { caller: string; trusted: boolean }

// the board is saved under ./board, its live elements under ./ui; the process is "trello" (a name
// of its own: a process shadows what is saved at its path). a folder is a node whose value is the
// order of its children's ids and whose children are named by those ids: lists under board/lists,
// a list's cards under its cards. a created node is named by its own id, so a node is read by id
// whether it is placed or not (a removed card is only unplaced)
const LISTS: Names = ["board", "lists"]
const cardsOf = (list: string): Names => [...LISTS, list, "cards"]
const str = (p: Names) => "/" + p.join("/")
const nodeId = (id: string): Node => ({ id, part: "value" })

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

export default function program(api: API & { who: () => Who }) {
	const { open, create, read, edit, entries, list, memo, effect, method, send, watch } = api
	const { place, unplace, move, ref, teardown, pulse, who } = api

	// a live thing kept across reloads: saved under ./ui, made the first time only
	const keep = <T>(name: string, make: () => T): T => read(ref(`./ui/${name}`, make)) as T
	// the look: a style element kept across reloads, its text set by every setup
	const style = keep("style", () => document.head.appendChild(document.createElement("style")))
	style.textContent = LOOK
	keep("font", () =>
		document.head.appendChild(Object.assign(document.createElement("link"), {
			rel: "stylesheet",
			href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap",
		})))

	// ---- the board
	const idAt = (p: Names) => entries(str(p))[0]?.id as string | undefined
	// a folder: its order, and its children made here, so a first child is a change like any other
	function folder(p: Names) {
		open(str(p), [])
		const kids = { path: p, part: "children" } as const
		if (read(kids) === undefined) edit(kids, [{ path: [], value: {} }])
	}
	const fresh = entries(str(LISTS)).length === 0
	folder(LISTS)
	const history = open("./board/history", { steps: [], at: 0, count: 0 })
	// whose history is open: the board, a list or a card
	const drawing = open("./board/drawer", null)

	// ---- what the graph says: a memo lands at stats
	const order = (f: Names) => (read(str(f)) as string[] | undefined) ?? []
	const idsIn = (f: Names) => order(f).filter((k) => !ghosted(k))
	const nameOf = (list: string) => read(nodeId(list)) as string
	const textOf = (card: string) => (read(nodeId(card)) as { text: string } | undefined)?.text
	const listOf = (card: string) => idsIn(LISTS).find((l) => idsIn(cardsOf(l)).includes(card))
	const stats = memo("stats", () => {
		const lists = idsIn(LISTS)
		let cards = 0
		for (const l of lists) cards += idsIn(cardsOf(l)).length
		return `${cards} cards · ${lists.length} lists`
	})

	// ---- the undo history. every call that says what it did is a step: the writes it made to the
	// board, each with the change's patches and their inverse (op.undo)
	let step: { writes: Write[]; words?: string; about?: string[]; undid?: number } | undefined
	// f, with what lands at a node (its value, or its children) kept for the step going on
	function track(node: { path: Names; part: "value" | "children" }, f: () => void) {
		if (!step) return f()
		const id = idAt(node.path)
		const mine = step
		const stop = watch(node as Node, ({ change, value }) => {
			const op = change?.op
			if (!op || id === undefined) return
			const w: Write = { part: node.part, id, undo: op.undo, redo: op.patches }
			const m = op.patches.find((x) => x.move)
			if (m && Array.isArray(value)) w.moved = value[m.range[0]]
			mine.writes.push(w)
		})
		try {
			f()
		} finally {
			stop()
		}
	}
	const val = (p: Names) => ({ path: p, part: "value" } as const)
	const kids = (p: Names) => ({ path: p, part: "children" } as const)
	// the id in at index of a folder's order, or out
	function put(f: Names, id: string, index?: number) {
		const at = Math.min(index ?? order(f).length, order(f).length)
		track(val(f), () => edit(str(f), [{ path: [], range: [at, at], value: [id] }]))
	}
	function cut(f: Names, id: string) {
		const at = order(f).indexOf(id)
		if (at >= 0) track(val(f), () => edit(str(f), [{ path: [], range: [at, at + 1] }]))
	}
	// a new node under the folder, named by its own id, its id in the order at index (the end)
	function add(f: Names, value: unknown, index?: number): string {
		let id!: string
		track(kids(f), () => void (id = create(str(f), value).path![f.length]))
		put(f, id, index)
		return id
	}
	// the child out of the folder and out of its order; its node stays, unplaced
	function take(f: Names, id: string) {
		track(kids(f), () => unplace(`${str(f)}/${id}`))
		cut(f, id)
	}
	// the child out of the folder from, into the folder to at index k (counted without it): in the
	// same folder only its place in the order changes; else places' own move, so the node, and its
	// id, stay the same
	function shove(from: Names, id: string, to: Names, k: number) {
		if (str(from) === str(to)) {
			const f = order(from).indexOf(id)
			if (f < 0 || f === k) return
			track(
				val(from),
				() =>
					edit(str(from), [{
						path: [],
						range: [k, k],
						move: { path: [], range: [f, f + 1] },
					}]),
			)
			return
		}
		track(
			kids(from),
			() => track(kids(to), () => move(`${str(from)}/${id}`, `${str(to)}/${id}`)),
		)
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
		if (at >= 0) edit(str(g.folder), [{ path: [], range: [at, at + 1] }])
	}
	function ghostAt(f: Names, id: string, index: number) {
		unghost()
		place(`${str(f)}/drag:${id}`, nodeId(id))
		const at = Math.min(index, order(f).length)
		edit(str(f), [{ path: [], range: [at, at], value: ["drag:" + id] }])
		ghost = { folder: f, id }
	}

	// every node on the board now (placed, ghosts apart), table id -> its names from the root
	function reachable() {
		const here = new Map<string, Names>()
		const visit = (p: Names) => {
			const id = idAt(p)
			if (id !== undefined) here.set(id, p)
		}
		visit(LISTS)
		for (const l of idsIn(LISTS)) {
			visit([...LISTS, l])
			visit(cardsOf(l))
			for (const c of idsIn(cardsOf(l))) visit([...cardsOf(l), c])
		}
		return here
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
			trusted: by.trusted,
			time: Date.now(),
			writes: s.writes,
		}
		edit(history, [
			{ path: ["steps"], range: [at, steps.length], value: [entry] },
			{ path: ["at"], value: at + 1 },
			{ path: ["count"], value: count + 1 },
		])
	}
	// undo, redo: a step's inverses applied newest first, or its patches again oldest first
	function travel(by: number) {
		const { steps, at } = read(history) as History
		const s = by < 0 ? steps[at - 1] : steps[at]
		if (!s) return
		const writes = by < 0 ? [...s.writes].reverse() : s.writes
		for (const w of writes) edit({ id: w.id, part: w.part }, by < 0 ? w.undo : w.redo)
		edit(history, [{ path: ["at"], value: at + by }])
	}

	// undo just step n: what it would do (nothing written), as per node patches carried through
	// every later change to it; or why it can't: gone (the node is not on the board now), again (a
	// later change set the same thing), overlap, inside (a later change touched the same items or
	// words), lost; by: that later step
	function plan(n: number): any {
		const { steps, at } = read(history) as History
		const k = steps.findIndex((x) => x.n === n)
		if (k < 0 || k >= at) return { ok: false, why: "undone" }
		const s = steps[k], later = steps.slice(k + 1, at)
		const here = reachable()
		const out: any[] = []
		for (let i = s.writes.length - 1; i >= 0; i--) {
			const w = s.writes[i]
			const mine = (x: Write) => x.part === w.part && x.id === w.id
			const no = (why: string, by?: Stp) => ({
				ok: false,
				why,
				id: w.id,
				part: w.part,
				step: s,
				by,
			})
			if (!here.has(w.id)) return no("gone", remover(later, w.id))
			// everything that changed this node after w, in order: the rest of its step, the steps
			// after it, and the inverses already worked out here
			const through: (readonly Patch[])[] = [], whose: Stp[] = []
			for (const x of s.writes.slice(i + 1)) if (mine(x)) (through.push(x.redo), whose.push(s))
			for (const l of later) {
				for (const x of l.writes) if (mine(x)) (through.push(x.redo), whose.push(l))
			}
			for (const o of out) if (mine(o)) (through.push(o.patches), whose.push(s))
			let rebased: Patch[]
			try {
				rebased = rebase(w.undo, through)
			} catch (e) {
				if (e instanceof Conflict) return no(e.why, whose[e.at])
				throw e
			}
			// on the value as it is now: the entries it takes out or moves must be the ones it means
			const before = read({ id: w.id, part: w.part })
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
				part: w.part,
				id: w.id,
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
	// did an undo step. act: a method that keeps its writes for the step, and puts it on the history
	// when it said (say) what it did
	const say = (words: string, ...about: (string | undefined)[]) => {
		if (step) (step.words = words, step.about = about.filter(Boolean) as string[])
	}
	function act(name: string, fn: (...a: any[]) => unknown, steps = true) {
		method(`on/${name}`, (...a: unknown[]) => {
			const was = step
			if (steps) step = { writes: [] }
			try {
				return fn(...a)
			} finally {
				const done = step
				step = was
				if (steps && done?.words && done.writes.length) remember(done, who())
			}
		})
	}
	act("add-card", (list: string, text: string) => {
		const card = add(cardsOf(list), { text, tint: "none" })
		say(`added ${em(text)} to ${em(nameOf(list))}`, list, card)
	})
	// an edit is a splice: only the words that changed
	act("edit-card", (card: string, text: string) => {
		const was = textOf(card)!
		const [at, out, put] = differ(was, text)
		const list = listOf(card)!
		track(val([...cardsOf(list), card]), () =>
			edit(
				nodeId(card),
				(d: any, { splice }: any) => void splice(d, "text", at, out, put || undefined),
			))
		say(`changed ${em(was)} to ${em(text)}`, card, list)
	})
	act("tint", (card: string) => {
		let next = ""
		const list = listOf(card)!
		track(val([...cardsOf(list), card]), () =>
			edit(nodeId(card), (d: any) => {
				d.tint = next = TINTS[(TINTS.indexOf(d.tint) + 1) % TINTS.length]
			}))
		say(
			next === "none"
				? `took the colour off ${em(textOf(card))}`
				: `coloured ${em(textOf(card))} ${next}`,
			card,
			list,
		)
	})
	act("remove-card", (list: string, card: string) => {
		take(cardsOf(list), card)
		say(`removed ${em(textOf(card))} from ${em(nameOf(list))}`, card, list)
	})
	act("add-list", (text: string) => {
		const list = add(LISTS, text)
		folder(cardsOf(list))
		say(`added the list ${em(text)}`, list)
	})
	act("rename-list", (list: string, text: string) => {
		const was = nameOf(list)
		const [at, out, put] = differ(was, text)
		track(
			val([...LISTS, list]),
			() =>
				edit(
					nodeId(list),
					(d: any, { splice }: any) => void splice(d, at, out, put || undefined),
				),
		)
		say(`renamed the list ${em(was)} to ${em(text)}`, list)
	})
	// a list goes with its cards still under it: undo places it back whole
	act("remove-list", (list: string) => {
		take(LISTS, list)
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
	act("move", (kind: string, from: string, id: string) => {
		const g = where()
		if (!g) return
		// the place among the others: what the ghost had before it, the dragged one not counted
		const k = order(g.folder).filter((x, j) => !ghosted(x) && x !== id && j < g.index).length
		unghost()
		const source = kind === "card" ? cardsOf(from) : LISTS
		const i = idsIn(source).indexOf(id)
		shove(source, id, g.folder, k)
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
	// undo just step n: worked out, or why not; done, it is a step of its own, which says it undid
	act("revert", (n: number) => {
		unghost()
		const r = plan(n)
		if (!r.ok) return r
		const here = reachable()
		for (const w of r.writes) {
			const at = here.get(w.id)!
			track({ path: at, part: w.part }, () => edit({ id: w.id, part: w.part }, w.patches))
		}
		if (step) step.undid = n
		say(`undid #${n}: ${r.step.words}`, ...r.step.about)
		return r
	})
	act(
		"open",
		(kind: string | null, id: string) =>
			edit(drawing, [{ path: [], value: kind ? { kind, id } : null }]),
		false,
	)
	act("cancel", () => unghost(), false)
	act("undo", () => (unghost(), travel(-1)), false)
	act("redo", () => (unghost(), travel(1)), false)
	// a call from the page: pulsed at once (the drop reads the lists it made)
	const call = (name: string, args: unknown[], _e?: unknown) => {
		const r = send(`on/${name}`, ...args)
		pulse()
		return r
	}

	// the first time only: the board seeded
	if (fresh) {
		for (const [title, cards] of SEED) {
			const list = add(LISTS, title)
			folder(cardsOf(list))
			for (const [text, tint] of cards) add(cardsOf(list), { text, tint })
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
	effect("summary", () => read(stats), (v) => (tag.textContent = v == null ? "" : String(v)))
	const undo = keep("undo", () => document.createElement("button"))
	const redo = keep("redo", () => document.createElement("button"))
	undo.onclick = (e) => call("undo", [], e)
	redo.onclick = (e) => call("redo", [], e)
	const fill = keep(
		"fill",
		() => Object.assign(document.createElement("span"), { className: "fill" }),
	)
	const all = keep("all", () => document.createElement("button"))
	all.textContent = "🕘 history"
	all.onclick = (e) => call("open", ["board", "board"], e)
	mount(top, [title, tag, fill, all, undo, redo])
	effect("buttons", () => {
		const { steps, at } = read(history) as History
		return [at, steps.length, steps[at - 1]?.words ?? "", steps[at]?.words ?? ""] as const
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
	document.onkeydown = (e) => {
		if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return
		if (
			(e.target as HTMLElement).isContentEditable ||
			(e.target as HTMLElement).tagName === "TEXTAREA"
		) return
		e.preventDefault()
		call(e.shiftKey ? "redo" : "undo", [], e)
	}

	const lists = keep(
		"columns-box",
		() => Object.assign(document.createElement("div"), { className: "lists" }),
	)
	const newlist: any = keep("newlist", () => adder("+ add a list", "list title"))
	newlist.classList.add("newlist")
	newlist.submit = (text: string, e: unknown) => call("add-list", [text], e)

	// the columns: one per id in board/lists' order, a ghost column where a dragged list would go
	effect("columns", () => [...order(LISTS)], (keys) => {
		mount(lists, [...keys.map((k) => column(k)), newlist])
	}, { equal: same })

	function column(k: string) {
		const id = k.replace(/^drag:/, "")
		if (ghosted(k)) {
			const g = keep(
				"ghostlist",
				() => Object.assign(document.createElement("div"), { className: "list ghost" }),
			)
			g.textContent = read(nodeId(id)) as string
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
		;(col.querySelector(".x") as HTMLElement).onclick = (e) => call("remove-list", [id], e)
		;(col.querySelector(".h") as HTMLElement).onclick = (e) => call("open", ["list", id], e)
		;(col.querySelector(".add") as any).submit = (text: string, e: unknown) =>
			call("add-card", [id, text], e)
		editable(name, () => nameOf(id), (text, e) => call("rename-list", [id, text], e))
		draggable(col.querySelector("header") as HTMLElement, col, "list", () => null, id)
		effect(`title-${id}`, () => read(nodeId(id)) as string, (v) => {
			if (document.activeElement !== name) name.textContent = v
		})
		effect(`size-${id}`, () => [...order(cardsOf(id))], (keys) => {
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
		;(el.querySelector(".x") as HTMLElement).onclick = (e) =>
			call("remove-card", [el.dataset.list, id], e)
		;(el.querySelector(".dot") as HTMLElement).onclick = (e) => call("tint", [id], e)
		;(el.querySelector(".h") as HTMLElement).onclick = (e) => call("open", ["card", id], e)

		editable(text, () => textOf(id)!, (v, e) => call("edit-card", [id, v], e), el)
		draggable(el, el, "card", () => el.dataset.list!, id)
		effect(`draw-${id}`, () => read(nodeId(id)) as { text: string; tint: string }, (v) => {
			if (document.activeElement !== text) text.textContent = v.text
			el.dataset.tint = v.tint
			const next = TINTS[(TINTS.indexOf(v.tint) + 1) % TINTS.length]
			el.style.setProperty("--next", next === "none" ? "#fff" : `var(--${next}, ${tint(next)})`)
		})
		return el
	}

	// ---- the history drawer: the steps that touched what is open, newest first. each can be
	// undone alone: first what it would do (or why it can't), then, asked, done
	const drawer = keep(
		"drawer",
		() => Object.assign(document.createElement("aside"), { className: "drawer" }),
	)
	effect("panel", () => {
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
		const folderId = o.kind === "list" ? idAt(cardsOf(o.id)) : undefined
		const rows = applied.filter((x) =>
			o.kind === "board" || x.about?.includes(o.id) || x.writes.some((w) => w.id === o.id) ||
			(folderId !== undefined && x.writes.some((w) => w.id === folderId))
		).reverse()
		return { o, name, rows, undone }
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
		;(drawer.querySelector(".close") as HTMLElement).onclick = (e) => call("open", [null], e)
		for (const x of v.rows) drawer.append(row(x, v.undone.has(x.n)))
	})

	function row(x: Stp, done: boolean) {
		const r = Object.assign(document.createElement("div"), {
			className: "step" + (done ? " done" : ""),
		})
		const when = new Date(x.time).toLocaleTimeString()
		r.innerHTML = `<div class="line"><span class="no">#${x.n}</span><span>${
			x.trusted ? "you" : esc(x.caller) + " (a script)"
		} ${words(x.words)}</span></div><div class="meta">${when}${
			done ? " · undone since" : ""
		}</div><div class="acts"><button class="one">undo just this</button></div><div class="pre" hidden></div>`
		const pre = r.querySelector(".pre") as HTMLElement
		const one = r.querySelector(".one") as HTMLElement
		one.onclick = () => {
			const plan_ = plan(x.n)
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
				pre.innerHTML = `<b>it would:</b>` + plan_.writes.map(change).join("") +
					`<p class="how">${
						later
							? `carried through ${later} later change${later > 1 ? "s" : ""}${
								moved ? ": its places moved" : ""
							}`
							: "nothing changed it since"
					}</p><div class="acts"><button class="go">undo it</button><button class="nm">never mind</button></div>`
				;(pre.querySelector(".go") as HTMLElement).onclick = (e) => {
					const done = call("revert", [x.n], e) as any
					if (done && !done.ok) {
						pre.className = "pre nope"
						pre.innerHTML = `can't undo ${words(x.words)}: ${why(done)}`
					}
				}
			}
			;(pre.querySelector(".nm") as HTMLElement).onclick =
				() => (pre.hidden = true, one.hidden = false)
		}
		return r
	}

	// a node's value now and after, in words: a list's cards in order, a card's words and colour,
	// a list's title
	function change(w: any) {
		// the names placed or taken out are in the order too: the order is what is shown
		if (w.part === "children") return ""
		if (Array.isArray(w.after)) {
			const board = w.id === idAt(LISTS)
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
			const owner = board
				? "the lists"
				: nameOf(idsIn(LISTS).find((l) => idAt(cardsOf(l)) === w.id)!) ?? "a list"
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
		const v = plan.part === "value" ? read(nodeId(plan.id)) : undefined
		const card = v !== undefined && typeof v !== "string" && !Array.isArray(v)
		const order = Array.isArray(v)
		if (plan.why === "undone") return "it is not on the history now"
		if (plan.why === "gone") {
			return card
				? `<em>${esc(textOf(plan.id) ?? "")}</em> was removed after${then}`
				: order
				? `the list was removed after${then}`
				: `the list <em>${esc(nameOf(plan.id))}</em> was removed after${then}`
		}
		if (plan.why === "again") return `it was changed again after${then}`
		if (plan.why === "overlap" || plan.why === "inside") {
			return order || plan.part === "children"
				? `a later change moved or removed the same card${then}`
				: `a later change edited the same words${then}`
		}
		return "the list is not as its history says (something changed it off the record)"
	}

	mount(view, [top, lists, drawer])
	teardown((why) => why === "ended" && view.remove())
	return view

	// ---- by hand: the DOM side of a drag. a float follows the pointer (DOM only); the drop spot is
	// the graph's (a hover call places the ghost), so the lists draw it like any entry. the
	// listeners are the document's: a mount moving the dragged element would drop a capture
	function draggable(handle, el, kind, from, id) {
		handle.onpointerdown = (down) => {
			if (
				down.button !== 0 ||
				(down.target as HTMLElement).closest("button,[contenteditable=true]")
			) return
			const box = el.getBoundingClientRect()
			const dx = down.clientX - box.left, dy = down.clientY - box.top
			let float, last = ""
			const source = from()
			const move = (e) => {
				if (!float) {
					if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) return
					float = el.cloneNode(true)
					float.classList.add("float")
					float.style.width = box.width + "px"
					document.body.append(float)
					el.classList.add("lifted")
				}
				float.style.left = e.clientX - dx + "px"
				float.style.top = e.clientY - dy + "px"
				const spot = spotAt(kind, e.clientX, e.clientY, id)
				if (spot && spot.join() !== last) {
					last = spot.join()
					call("hover", [kind, spot[0], spot[1], id], e)
				}
			}
			const finish = (e, drop) => {
				document.removeEventListener("pointermove", move)
				document.removeEventListener("pointerup", up)
				document.removeEventListener("pointercancel", cancel)
				document.removeEventListener("keydown", escape)
				if (!float) return
				float.remove()
				el.classList.remove("lifted")
				if (!drop) return call("cancel", [], e)
				call("move", [kind, source, id], e)
				const into = lists.querySelector(`[data-card="${id}"]`)?.closest(".list")
				if (kind === "card" && /done/i.test(into?.querySelector(".name")?.textContent ?? "")) {
					if (into.dataset.list !== source) burst(e.clientX, e.clientY)
				}
			}
			const up = (e) => finish(e, true)
			const cancel = (e) => finish(e, false)
			const escape = (e) => e.key === "Escape" && finish(e, false)
			document.addEventListener("pointermove", move)
			document.addEventListener("pointerup", up)
			document.addEventListener("pointercancel", cancel)
			document.addEventListener("keydown", escape)
		}
	}

	// where a drop would land: [list id, place among the others], or [null, place] for a list
	function spotAt(kind, x, y, id) {
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

	// double-click to edit in place: enter keeps it, escape puts it back
	function editable(el, now, save, frame = el) {
		frame.ondblclick = () => {
			el.contentEditable = "true"
			frame.classList.add("editing")
			el.focus()
			getSelection().selectAllChildren(el)
		}
		el.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), el.blur())
			if (e.key === "Escape") (el.textContent = now(), el.blur())
		}
		el.onblur = (e) => {
			el.contentEditable = "false"
			frame.classList.remove("editing")
			const v = el.textContent.trim()
			if (v && v !== now()) save(v, e)
			else el.textContent = now()
		}
	}

	// "+ add a card": a button that opens into a textarea; enter adds and stays open
	function adder(label, hint) {
		const el = Object.assign(document.createElement("div"), { className: "add" }) as any
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
		const show = (on) => {
			open.hidden = on
			area.hidden = row.hidden = !on
			if (on) area.focus()
		}
		const add = (e) => {
			const text = area.value.trim()
			if (text) el.submit(text, e)
			area.value = ""
			area.focus()
		}
		open.onclick = () => show(true)
		no.onclick = () => show(false)
		go.onclick = add
		area.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), add(e))
			if (e.key === "Escape") show(false)
		}
		el.append(open, area, row)
		show(false)
		return el
	}
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
