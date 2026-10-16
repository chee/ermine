/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// piece-skin: my tweak over a shared thing. the card at /shared/card is everyone's; my tweak is a
// patch node in my own tree at /me/tweaks/cherry, laid over the card's value (patch-nodes'
// overlay). while it is loaded (its "patch" entry in the table) a read of the card gets my way;
// unloaded, the card as it is. dragging with it on moves the card only in my tweak: the shared
// spot stays where it was, a dashed ghost. a friend's edit lands under it and makes it stale (made
// against an older card), still applied. land puts it on the card for real. the api has it: patch
// makes the node, layers reads every layer, land lands it. put it on the shelf and it is taken out
// of the tree (remove), its patches kept; load it and it is made again (patch)

type Patch = { path: (string | number)[]; value?: unknown }
type Tweak = { on: unknown; part: string; at: number; patches: Patch[] }
type Card = { title: string; body: string; x: number; y: number; accent: string; sticker: string }
type Item = { value: unknown; from: unknown; stale?: true; error?: unknown }
// what the host's extend adds (host.ts): the card's latest change, and a write as another actor
type Host = {
	change: (x: string) => { time: number; actor?: string } | undefined
	as: <T>(actor: string, f: () => T) => T
}
type Seen = {
	front: Card
	table: Card
	layers: { from: string; stale: boolean; error?: string }[]
	tweak?: Tweak
	shelved: boolean
	placed: boolean
	time?: number
	actor?: string
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

export default function program(
	{ open, read, edit, entries, memo, method, send, patch, land, layers, remove, change, as }:
		& API
		& Host,
) {
	// the tweak's "patch" entry (what it is over, the card's time it was made at, its patches): a
	// part of the node there, loaded while it is in the table
	const patchNode = { path: ["me", "tweaks", "cherry"], part: "patch" as const }
	const tweakNow = () => read(patchNode) as Tweak | undefined
	// the tweak while it is on the shelf: out of the tree, read by nobody
	const shelf = open("/me/shelf", null)
	const put = (x: typeof shelf, value: unknown) => edit(x, [{ path: [], value }])
	const turn = open("turn", 0)

	// what the view shows: the card a read gets (front), the table's own, every layer front first
	memo("seen", (): Seen => {
		const all = layers(CARD) as Item[]
		const tweak = tweakNow()
		const latest = change(CARD)
		const shelved = read(shelf) !== null
		return {
			front: all[0]?.value as Card,
			table: all[all.length - 1]?.value as Card,
			layers: all.map((l) => ({
				from: l.from === "table" ? "table" : String(l.from),
				stale: !!l.stale,
				error: l.error ? String(l.error) : undefined,
			})),
			tweak,
			shelved,
			placed: !!tweak || shelved,
			time: latest?.time,
			actor: latest?.actor,
		}
	})

	// a drag: my tweak loaded, the place goes into its patches (never the card); else a real write
	method("on/drag", (x: number, y: number) => {
		const tweak = tweakNow()
		if (tweak) {
			const rest = tweak.patches.filter((p) => p.path[0] !== "x" && p.path[0] !== "y")
			const patches = [...rest, { path: ["x"], value: x }, { path: ["y"], value: y }]
			edit(patchNode, [{ path: ["patches"], value: patches }])
		} else edit(CARD, [{ path: ["x"], value: x }, { path: ["y"], value: y }])
	})
	method("on/toggle", () => {
		const tweak = tweakNow()
		const shelved = read(shelf) as Tweak | null
		if (tweak) {
			put(shelf, tweak)
			remove(CHERRY)
		} else if (shelved) {
			patch(CHERRY, CARD, shelved.patches)
			put(shelf, null)
		}
	})
	method("on/friend", () => {
		const n = read(turn) as number
		put(turn, n + 1)
		const what = edits[n % edits.length]
		as(
			"friend@phone",
			() => edit(CARD, Object.entries(what).map(([k, value]) => ({ path: [k], value }))),
		)
	})
	// made again against the card as it is now: no longer stale
	method("on/again", () => {
		const tweak = tweakNow()
		if (tweak) patch(CHERRY, CARD, tweak.patches)
	})
	method("on/land", () => {
		if (!tweakNow()) return
		land(CHERRY)
		remove(CHERRY)
	})
	method("on/new", () => {
		if (tweakNow() || read(shelf) !== null) return
		patch(CHERRY, CARD, mine)
	})

	// ---- the desk: the card where a read puts it, the shared spot as a ghost under it ----
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
		send("on/drag", x, y)
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
							onPointerMove={move}
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
													last change {clock(v.time)} by {v.actor}
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
												<code>{l.from.slice(0, 6)}</code>
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
