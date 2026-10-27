/** @jsxImportSource ermine-h */
import {
	createAction,
	createMemo,
	ensureNode,
	executeAction,
	explain,
	patch,
	peep,
	read,
	unplace,
} from "@ermine/system"
import { createPatch, layers } from "@ermine/patchy/feature"
import { bind, handler } from "ermine-h"

// piece-skin: my tweak over a shared thing. the card at /shared/card is everyone's; my tweak is a
// patch node in my own tree at /me/tweaks/cherry, laid over the card's value (patchy's
// overlay). while it is loaded (its "patch" entry in the table) a read of the card gets my way;
// unloaded, the card as it is. dragging with it on moves the card only in my tweak: the shared
// spot stays where it was, a dashed ghost. a friend's edit lands under it and makes it stale (made
// against an older card), still applied. land puts it on the card for real. patchy has it:
// createPatch makes the node, layers reads every layer, the host's /system/land lands it. put it
// on the shelf and it is taken out of the tree (the host's /system/unload: a program's unplace leaves
// the patch entry, still read through), its patches kept; load it and it is made
// again (createPatch). a program holds no patch entry (a node's "patch" part is the feature's), so
// what the tweak says (its patches, the card's time it was made against) is a node of its own,
// /me/tweak, written with each createPatch. the pointer is jsx (handlers), a listener of the
// program's own having nothing open to write in. an actor is the host's: the friend's edit is
// written as the host is, and /me/by says who made it

type Patch = { path: (string | number)[]; value?: unknown }
type Tweak = { on: unknown; part: string; at: number; patches: Patch[] }
type Card = { title: string; body: string; x: number; y: number; accent: string; sticker: string }
type Item = { value: unknown; from: unknown; stale?: true; error?: unknown }
type Seen = {
	front: Card
	table: Card
	layers: { from: string; stale: boolean; error?: string }[]
	tweak?: Tweak
	shelved: boolean
	placed: boolean
	time?: number
	actor?: string
	by?: string
}

const W = 340, H = 230, CW = 150, CH = 92
const fields = ["title", "body", "accent", "sticker", "x", "y"] as const
const clock = (t?: number) =>
	t === undefined ? "–" : new Date(t * 1000).toLocaleTimeString([], { hour12: false })
const show = (p: Patch) => `${p.path.join(".")} = ${JSON.stringify(p.value)}`

// what a friend does to the card, in turn
const edits: Partial<Card>[] = [
	{ title: "our note ✎", accent: "#2269ff" },
	{ body: "lunch at two, actually 🍜" },
	{ sticker: "🌻", accent: "#ffcc00" },
	{ title: "our note", body: "lunch at one? 🥪", accent: "#40dcba", sticker: "🌱" },
]

const mine: Patch[] = [
	{ path: ["accent"], value: "#ff2284" },
	{ path: ["sticker"], value: "🍒" },
]

const CARD = "/shared/card"
const CHERRY = "/me/tweaks/cherry"

export default function program() {
	// what my tweak says (its patches, the card's time it was made against): a node of my own, none
	// while there is no tweak. loaded: a patch node is at /me/tweaks/cherry; else on the shelf
	const rec = ensureNode("/me/tweak", null)
	const by = ensureNode("/me/by", "")
	const turn = ensureNode("turn", 0)
	const now = <T,>(f: () => T) => peep(f)
	const put = (x: typeof rec, value: unknown) => patch(x, [{ path: [], value }])
	const tweakNow = () => now(() => read(rec)) as Tweak | null
	// the card's time now: what a patch node made now is made against
	const cardTime = () => now(() => explain(CARD))?.change?.time ?? 0
	// the tweak made (again) against the card as it is now: its patch node, and what I say of it
	const make = (patches: Patch[]) => {
		createPatch(CHERRY, CARD, patches)
		put(rec, { on: CARD, part: "value", at: cardTime(), patches } satisfies Tweak)
	}
	const loaded = () => now(() => layers(CARD)).some((l) => l.from !== "table")
	// the first time only: my tweak, made against the card
	const seeded = ensureNode("/me/seeded", false)
	if (!now(() => read(seeded))) {
		make(mine)
		put(seeded, true)
	}

	// what the view shows: the card a read gets (front), the table's own, every layer front first
	createMemo("seen", (): Seen => {
		const all = layers(CARD)
		const there = all.some((l) => l.from !== "table")
		const tweak = read(rec) as Tweak | null
		const latest = explain(CARD)?.change
		const said = read(by) as string
		return {
			front: all[0]?.value as Card,
			table: all[all.length - 1]?.value as Card,
			layers: all.map((l) => ({
				from: l.from === "table" ? "table" : String(l.from?.join("/")),
				stale: !!l.stale,
				error: l.error ? String(l.error) : undefined,
			})),
			tweak: there ? tweak ?? undefined : undefined,
			shelved: !there && tweak !== null,
			placed: tweak !== null,
			time: latest?.time,
			actor: latest?.actor === undefined ? undefined : String(latest.actor),
			by: said || undefined,
		}
	})

	// a drag: my tweak loaded, the place goes into its patches (never the card); else a real write
	createAction("on/drag", (x: number, y: number) => {
		const tweak = tweakNow()
		if (tweak && loaded()) {
			const rest = tweak.patches.filter((p) => p.path[0] !== "x" && p.path[0] !== "y")
			make([...rest, { path: ["x"], value: x }, { path: ["y"], value: y }])
		} else patch(CARD, [{ path: ["x"], value: x }, { path: ["y"], value: y }])
	})
	createAction("on/toggle", () => {
		const tweak = tweakNow()
		if (!tweak) return
		if (loaded()) executeAction("/system/unload", CHERRY)
		else make(tweak.patches)
	})
	createAction("on/friend", () => {
		const n = now(() => read(turn)) as number
		put(turn, n + 1)
		const what = edits[n % edits.length]
		put(by, "friend@phone")
		patch(CARD, Object.entries(what).map(([k, value]) => ({ path: [k], value })))
	})
	// made again against the card as it is now: no longer stale
	createAction("on/again", () => {
		const tweak = tweakNow()
		if (tweak) make(tweak.patches)
	})
	createAction("on/land", () => {
		const tweak = tweakNow()
		if (!tweak || !loaded()) return
		executeAction("/system/land", CHERRY)
		unplace(CHERRY)
		put(rec, null)
		put(by, "chee@laptop")
	})
	createAction("on/new", () => {
		if (tweakNow()) return
		make(mine)
	})

	// ---- the desk: the card where a read puts it, the shared spot as a ghost under it ----
	// a grab is DOM only; each move is a handler's args, the action it runs writes
	let grab: { dx: number; dy: number } | undefined
	const desk = (e: PointerEvent) => (e.currentTarget as HTMLElement).parentElement!
	const down = (e: PointerEvent) => {
		const el = e.currentTarget as HTMLElement
		const r = el.getBoundingClientRect()
		grab = { dx: e.clientX - r.left, dy: e.clientY - r.top }
		try {
			el.setPointerCapture(e.pointerId)
		} catch { /* a pointer the page made up: no capture */ }
	}
	const move = (e: PointerEvent) => {
		if (!grab) return
		const r = desk(e).getBoundingClientRect()
		const x = Math.round(Math.max(0, Math.min(W - CW, e.clientX - r.left - grab.dx)))
		const y = Math.round(Math.max(0, Math.min(H - CH, e.clientY - r.top - grab.dy)))
		return [x, y]
	}
	const up = () => (grab = undefined)

	const note = (c: Card | undefined) =>
		c
			? [
				<b class="band" style={{ background: c.accent }} />,
				<span class="sticker">{c.sticker}</span>,
				<strong>{c.title}</strong>,
				<p>{c.body}</p>,
			]
			: null

	return (
		<div class="sk">
			<style>{css}</style>
			<h1>
				skin<span>my tweak, over a shared thing</span>
			</h1>
			<p class="lede">
				the card at <code>/shared/card</code>{" "}
				is everyone's. my tweak is a patch node in my own tree, at{" "}
				<code>/me/tweaks/cherry</code>: while it is loaded, a read of the card gets my way. drag
				the card: with the tweak on, only my tweak moves, and the shared spot stays behind as a
				ghost.
			</p>
			<div class="cols">
				<section class="win deskwin">
					<header>
						<b class="close" />
						<span>/shared/card, as I read it</span>
					</header>
					<div class="desk" style={{ width: W + "px", height: H + "px" }}>
						<div
							class={bind("seen", (v: Seen) =>
								v.tweak && (v.table.x !== v.front.x || v.table.y !== v.front.y)
									? "card ghost"
									: "card ghost hidden")}
							style={bind(
								"seen",
								(v: Seen) => ({ left: v.table.x + "px", top: v.table.y + "px" }),
							)}
						>
							{bind("seen", (v: Seen) =>
								note(v.table))}
							<em class="said">the shared spot</em>
						</div>
						<div
							class={bind(
								"seen",
								(v: Seen) => (v.tweak ? "card front tweaked" : "card front"),
							)}
							style={bind(
								"seen",
								(v: Seen) => ({ left: v.front.x + "px", top: v.front.y + "px" }),
							)}
							onPointerDown={down}
							onPointerMove={handler("on/drag", move)}
							onPointerUp={up}
							onPointerCancel={up}
						>
							{bind("seen", (v: Seen) =>
								note(v.front))}
						</div>
					</div>
					<div class="row">
						<button
							class={bind("seen", (v: Seen) => (v.tweak ? "on" : ""))}
							onClick={handler("on/toggle")}
							disabled={bind("seen", (v: Seen) => !v.placed)}
						>
							{bind(
								"seen",
								(
									v: Seen,
								) => (v.tweak ? "🍒 my tweak: loaded" : "🍒 my tweak: on the shelf"),
							)}
						</button>
						<button onClick={handler("on/friend")}>📱 a friend edits the card</button>
					</div>
					<div class="row">
						<button
							onClick={handler("on/again")}
							disabled={bind("seen", (v: Seen) => !v.layers.some((l) => l.stale))}
						>
							make it again, against now
						</button>
						<button
							class="go"
							onClick={handler("on/land")}
							disabled={bind("seen", (v: Seen) => !v.tweak)}
						>
							land it on the card
						</button>
						<button
							onClick={handler("on/new")}
							disabled={bind("seen", (v: Seen) => v.placed)}
						>
							a new tweak
						</button>
					</div>
				</section>
				<section class="win layers">
					<header>
						<b class="close" />
						<span>layers, front first</span>
					</header>
					<div class="body">
						{bind("seen", (v: Seen) => [
							...v.layers.map((l, i) =>
								l.from === "table"
									? (
										<div
											class={i === 0 ? "layer table front" : "layer table"}
											key="table"
										>
											<div class="line">
												<b class="tag">📄 the table</b>
												<span>
													last change {clock(v.time)} by {v.by ?? v.actor}
												</span>
												{i === 0 ? <em class="first">a read takes this</em> : null}
											</div>
											<code>{JSON.stringify(v.table)}</code>
										</div>
									)
									: (
										<div class={`layer tweak${l.stale ? " stale" : ""}`} key={l.from}>
											<div class="line">
												<b class="tag cherry">🍒 /me/tweaks/cherry</b>
												<code>{l.from}</code>
												{i === 0
													? <em class="first">front: a read takes this</em>
													: null}
											</div>
											{l.stale
												? (
													<div class="stale-says">
														stale: made against the card at{" "}
														{clock(v.tweak?.at)}, the card is at{" "}
														{clock(v.time)}. still applied
													</div>
												)
												: (
													<div class="fresh">
														made against the card at {clock(v.tweak?.at)}
													</div>
												)}
											{l.error
												? <div class="stale-says">set aside: {l.error}</div>
												: null}
											<code>{(v.tweak?.patches ?? []).map(show).join("\n")}</code>
										</div>
									)
							),
							v.shelved
								? (
									<div class="layer shelf" key="shelf">
										<b class="tag">🍒 on the shelf</b>{" "}
										unloaded: not in the table, it counts for nothing
									</div>
								)
								: null,
						])}
						<table class="grid">
							<thead>
								<tr>
									<th />
									<th>a read gets</th>
									<th>the table has</th>
								</tr>
							</thead>
							<tbody>
								{fields.map((f) => (
									<tr
										key={f}
										class={bind(
											"seen",
											(v: Seen) => (v.front[f] !== v.table[f] ? "differs" : ""),
										)}
									>
										<th>{f}</th>
										<td>{bind("seen", (v: Seen) => String(v.front[f]))}</td>
										<td>{bind("seen", (v: Seen) => String(v.table[f]))}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			</div>
		</div>
	)
}

const css = `
.sk{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:12px 14px 16px;min-height:calc(100vh - 18px);box-sizing:border-box}
.sk *{box-sizing:border-box}
.sk h1{font-size:22px;margin:0 0 2px;font-weight:600}
.sk h1 span{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:8px}
.sk .lede{margin:0 0 12px;font-size:13.5px;line-height:1.35;max-width:660px}
.sk code{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:11px}
.sk .cols{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.sk .win{background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000}
.sk .win.deskwin{flex:0 0 362px;width:362px}
.sk .win.layers{flex:1 1 300px;min-width:280px;max-width:460px}
.sk .win header{position:relative;height:20px;border-bottom:1px solid #000;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 4px/100% 12px no-repeat,#fff}
.sk .win header span{background:#fff;padding:0 8px;font-size:12px;font-weight:600}
.sk .win .close{position:absolute;left:8px;top:4px;width:11px;height:11px;border:1px solid #000;background:#fff}
.sk .desk{position:relative;margin:10px;border:1px solid #000;background:#fff radial-gradient(#0002 1px,transparent 1.5px) 0 0/14px 14px;overflow:hidden;touch-action:none}
.sk .card{position:absolute;width:${CW}px;height:${CH}px;border:1px solid #000;background:#fff;padding:14px 8px 6px;box-shadow:2px 2px 0 #000;user-select:none;overflow:hidden}
.sk .card .band{position:absolute;left:0;right:0;top:0;height:9px;border-bottom:1px solid #000}
.sk .card .sticker{position:absolute;right:6px;top:12px;font-size:22px}
.sk .card strong{display:block;font-size:13px;font-weight:600;padding-right:28px}
.sk .card p{margin:3px 0 0;font-size:11.5px;line-height:1.25}
.sk .card.front{cursor:grab;z-index:2}
.sk .card.front:active{cursor:grabbing}
.sk .card.front.tweaked{box-shadow:3px 3px 0 #ff2284}
.sk .card.ghost{border-style:dashed;box-shadow:none;opacity:.5;z-index:1;background:transparent}
.sk .card.ghost.hidden{display:none}
.sk .card .said{position:absolute;left:6px;bottom:3px;font-size:10px;font-style:normal;font-weight:600}
.sk .row{display:flex;gap:6px;flex-wrap:wrap;margin:0 10px 8px}
.sk button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.sk button:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.sk button:active:not(:disabled){transform:translate(1px,1px);box-shadow:none}
.sk button:disabled{opacity:.35;cursor:default;box-shadow:none}
.sk button.on{background:#ff2284;color:#fff}
.sk button.go{background:#40dcba}
.sk .body{padding:10px;display:flex;flex-direction:column;gap:8px}
.sk .layer{border:1px solid #000;padding:6px 8px;font-size:12px;display:flex;flex-direction:column;gap:3px}
.sk .layer code{white-space:pre-wrap;word-break:break-all;background:#fbfbfb;border:1px dashed #000;padding:3px 5px}
.sk .layer.tweak{box-shadow:3px 3px 0 #ff2284;margin-right:4px}
.sk .layer.table{box-shadow:3px 3px 0 #000;margin-left:10px}
.sk .layer.table.front{margin-left:0}
.sk .layer.shelf{border-style:dashed;opacity:.75}
.sk .line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sk .tag{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 7px;transform:skewX(-10deg);font-size:12px;font-weight:600}
.sk .tag.cherry{background:#ff2284;color:#fff}
.sk .first{font-style:normal;font-size:11px;font-weight:600;color:#ff2284}
.sk .fresh{font-size:11.5px;opacity:.65}
.sk .stale-says{font-size:11.5px;font-weight:600;background:#ffff88;border:1px solid #000;padding:1px 6px;align-self:flex-start}
.sk .grid{border-collapse:collapse;font-size:12px;width:100%}
.sk .grid th,.sk .grid td{border:1px solid #000;padding:2px 6px;text-align:left;font-weight:500}
.sk .grid thead th{background:#fffbd6;font-weight:600}
.sk .grid tbody th{width:64px;font-family:Monaco,ui-monospace,monospace;font-size:11px}
.sk .grid tr.differs td:first-of-type{background:#ff2284;color:#fff}
`
