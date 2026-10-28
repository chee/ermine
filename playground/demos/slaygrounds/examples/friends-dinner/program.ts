/** @jsxImportSource @ermine */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	getCaller,
	patch,
	peep,
	read,
} from "@ermine/system"
import { bind, handler, under } from "@ermine/render/h"

// friends-dinner: dinner at mine, friday. say if you're coming, pick what you'll bring, send the
// invites. the post (a process of its own) brings the friends' replies one by one, from its timers.
// every guest is a node (./guests/<name>); where each one stands is one memo (seats):
// coming sits at the table in the order they said yes, maybe waits by the window, can't-come sends
// a card. the room and the list are two views of the same guest nodes. turn on 💡 explain and
// press "yes": it says what your click wrote and what ran because of it

// who's invited, and what each one says back by post: [after ms, answer, what they'll bring]
type Answer = "yes" | "maybe" | "no"
const FRIENDS: Record<string, { face: string; says: [number, Answer, string?][] }> = {
	fox: { face: "🦊", says: [[900, "yes", "🍷"]] },
	owl: { face: "🦉", says: [[1300, "maybe"], [9000, "yes", "🍰"]] },
	frog: { face: "🐸", says: [[1700, "yes", "🥗"]] },
	penguin: { face: "🐧", says: [[2100, "maybe"], [6000, "no"]] },
	cat: { face: "🐱", says: [[2500, "no"]] },
	bear: { face: "🐻", says: [[3000, "yes", "🍞"]] },
	mouse: { face: "🐭", says: [[3700, "yes", "🧀"]] },
	hedgehog: { face: "🦔", says: [[4400, "yes", "🍎"]] },
	rabbit: { face: "🐰", says: [[5200, "yes", "🥕"]] },
}
const FACE: Record<string, string> = {
	you: "🫵",
	...Object.fromEntries(Object.entries(FRIENDS).map(([n, f]) => [n, f.face])),
}
const DISHES = ["🥗", "🍞", "🧀", "🍰", "🍷"]
const PUDDING = ["🍰", "🍪", "🍮"]
type Guest = { answer: Answer | null; dish: string | null; at: number }
type Spot = {
	x: number
	y: number
	where: "table" | "window" | "away" | "post"
	dx?: number
	dy?: number
}
type Seats = { leaves: number; rx: number; ry: number; spots: Record<string, Spot> }

// the room: 430 by 290, the table in the middle. a leaf goes in for every two past six
const CX = 215, CY = 150
function seat(guests: [string, Guest][]): Seats {
	const yes = guests.filter(([, g]) => g.answer === "yes").sort((a, b) => a[1].at - b[1].at)
	const leaves = Math.max(0, Math.ceil((yes.length - 6) / 2))
	const n = 6 + leaves * 2
	const rx = 72 + leaves * 34, ry = 50
	const spots: Record<string, Spot> = {}
	yes.forEach(([name], i) => {
		const a = ((i + 0.5) / n) * 2 * Math.PI - Math.PI / 2
		const [c, s] = [Math.cos(a), Math.sin(a)]
		spots[name] = {
			x: CX + (rx + 26) * c,
			y: CY + (ry + 26) * s,
			where: "table",
			dx: -c * 34,
			dy: -s * 30,
		}
	})
	const line = (where: Spot["where"], answer: Answer | null, x: number, y: number, step: number) =>
		guests.filter(([, g]) => g.answer === answer).forEach(([name], k) =>
			spots[name] = { x: x + k * step, y, where }
		)
	line("window", "maybe", 120, 26, 36)
	line("away", "no", 370, 266, -40)
	line("post", null, 26, 266, 26)
	return { leaves, rx, ry, spots }
}
const at = (s?: Spot) => (s ? `left:${s.x}px;top:${s.y}px` : "display:none")
const say = (
	a: Answer | null,
) => (a === "yes" ? "yes!" : a === "maybe" ? "maybe…" : a === "no" ? "can't 💌" : "…")

const css = `
body { background: #ffff88; margin: 10px }
.dn { font-family: Jost, system-ui, sans-serif; max-width: 680px; margin: 0 auto }
.dn .top { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap }
.dn .tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 10px;
	transform: skew(-8deg); font-weight: 600; white-space: nowrap }
.dn .tag.w { background: #fff; font-weight: 400; font-size: 12px }
.dn .fill { flex: 1 }
.dn button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 1px 9px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform .1s, box-shadow .1s }
.dn button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
.dn button:active { transform: translate(1px, 1px); box-shadow: none }
.dn button:disabled { background: #ffffc2; box-shadow: none; transform: none; cursor: default }
.dn button.on { background: #ff2284; color: #fff }
.dn button.go { background: #2269ff; color: #fff }
.dn .row { display: flex; gap: 10px }
.dn .room { position: relative; flex: none; width: 430px; height: 290px; background: #fffbea;
	border: 1px solid #000; border-radius: 2px; box-shadow: 0 0 10px 2px #ff228433; overflow: hidden;
	background-image: linear-gradient(#0000000a 1px, transparent 1px); background-size: 100% 22px }
.dn .window { position: absolute; left: 100px; right: 100px; top: 0; height: 50px; border: 1px solid #000;
	border-top: 0; background: #d4e4ff; border-radius: 0 0 4px 4px }
.dn .window::after { content: "maybe…"; position: absolute; right: 6px; bottom: 2px; font-size: 10px; color: #0008 }
.dn .mat { position: absolute; left: 0; bottom: 0; width: 120px; height: 44px; border-top: 1px dashed #0006;
	border-right: 1px dashed #0006; font-size: 10px; color: #0008; padding: 2px 6px }
.dn .shelf { position: absolute; right: 0; bottom: 0; width: 150px; height: 44px; border-top: 1px dashed #0006;
	border-left: 1px dashed #0006; font-size: 10px; color: #0008; padding: 2px 6px; text-align: right }
.dn .table { position: absolute; border: 1.5px solid #000; border-radius: 50%; background: #fff;
	box-shadow: 3px 4px 0 #ff228466; transition: all .6s cubic-bezier(.3,1.5,.5,1);
	background-image: repeating-linear-gradient(90deg, transparent 0 var(--leaf), #0002 var(--leaf) calc(var(--leaf) + 1px)) }
.dn .table .leafy { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-3deg);
	white-space: nowrap; font-size: 11px; background: #ffff88; border: 1px solid #000; padding: 0 6px;
	animation: pop .5s cubic-bezier(.3,1.8,.5,1) both }
@keyframes pop { from { transform: translate(-50%, -50%) scale(0) } }
.dn .guest { position: absolute; width: 0; height: 0; transition: left .9s ease-in-out, top .9s ease-in-out }
.dn .guest .face { position: absolute; left: -15px; top: -15px; width: 30px; height: 30px; font-size: 24px;
	line-height: 30px; text-align: center }
.dn .guest.you .face { background: #ff2284; border-radius: 50%; border: 1px solid #000; font-size: 18px }
.dn .guest .dish { position: absolute; font-size: 15px; transform: translate(-50%, -50%);
	transition: left .9s, top .9s }
.dn .guest .say { position: absolute; left: 10px; top: -26px; font-size: 10px; background: #fff;
	border: 1px solid #000; border-radius: 8px 8px 8px 0; padding: 0 5px; white-space: nowrap;
	animation: pop2 2.5s both; pointer-events: none }
@keyframes pop2 { 0% { opacity: 0; transform: scale(.4) } 10%, 75% { opacity: 1; transform: none } 100% { opacity: 0 } }
.dn .list { flex: 1; min-width: 0; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 0 0 10px 2px #ff228433; padding: 4px 8px; font-size: 12px; height: 290px; box-sizing: border-box;
	overflow: hidden }
.dn .list h3 { margin: 2px 0 4px; font-size: 12px; font-weight: 600 }
.dn .list div { display: flex; gap: 4px; align-items: center; padding: 1px 0; border-bottom: 1px solid #0001 }
.dn .list b { margin-left: auto; font-weight: 600; border: 1px solid #000; border-radius: 8px; padding: 0 6px;
	font-size: 11px; background: #fff }
.dn .list b.yes { background: #40dcba } .dn .list b.maybe { background: #d4e4ff }
.dn .list b.no { background: #ff2284; color: #fff } .dn .list b.none { border-style: dashed; color: #0008 }
.dn .list small { color: #0008; font-size: 10px }
.dn .menu { margin-top: 8px; font-size: 12px }
.dn .bar { display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap; font-size: 13px }
.dn .warn { background: #ff2284; color: #fff; border: 1px solid #000; padding: 0 6px; transform: skew(-8deg);
	display: inline-block; animation: pop3 .5s both }
.dn .ok { background: #40dcba; border: 1px solid #000; padding: 0 6px; transform: skew(-8deg); display: inline-block }
@keyframes pop3 { from { transform: skew(-8deg) scale(.5) } }
`

// a node's value now, from an action (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0]) => peep(() => read(x)) as T

export default function dinner() {
	const names = ["you", ...Object.keys(FRIENDS)]
	const guest = Object.fromEntries(
		names.map((
			n,
		) => [n, ensureNode(`./guests/${n}`, { answer: null, dish: null, at: 0 } satisfies Guest)]),
	) as Record<string, ReturnType<typeof ensureNode>>
	const all = () => names.map((n) => [n, read(guest[n]) as Guest] as [string, Guest])

	createMemo("seats", () => seat(all()))
	createMemo("tally", () => {
		const n = (a: Answer | null) => all().filter(([, g]) => g.answer === a).length
		return `${n("yes")} coming · ${n("maybe")} maybe · ${n("no")} can't · ${
			n(null)
		} still deciding`
	})
	createMemo("menu", () => {
		const dishes = all().filter(([, g]) => g.answer === "yes" && g.dish).map(([, g]) => g.dish!)
		return { dishes, pudding: dishes.some((d) => PUDDING.includes(d)), any: dishes.length > 0 }
	})

	// an answer: yours from the buttons (this process calling, a person clicking), a friend's only
	// from the post. the name in the arguments counts only when the post is the caller (a caller's
	// process is named by where it runs: the post runs at mail/post)
	createAction("on/answer", (name: string, answer: Answer, dish?: string) => {
		const person = getCaller()?.process?.join("/") === "mail/post" ? name : "you"
		const g = get<Guest>(guest[person])
		const at = g.answer === answer ? g.at : Date.now()
		patch(guest[person], [
			{ path: ["answer"], value: answer },
			{ path: ["dish"], value: dish ?? g.dish },
			{ path: ["at"], value: at },
		])
	})
	createAction("on/bring", (dish: string) => {
		const g = get<Guest>(guest.you)
		patch(guest.you, [{ path: ["dish"], value: g.dish === dish ? null : dish }])
	})
	createAction("on/again", () => {
		for (const n of names) {
			patch(guest[n], [{ path: [], value: { answer: null, dish: null, at: 0 } }])
		}
		executeAction("/mail/post/on/reset")
	})

	return (
		<div class="dn">
			<style>{css}</style>
			<link
				rel="stylesheet"
				href="https://fonts.googleapis.com/css2?family=Jost:wght@400;600&display=swap"
			/>
			<div class="top">
				<span class="tag">dinner at mine · friday 7pm</span>
				<span class="tag w">{bind("tally")}</span>
				<span class="fill" />
				<button
					class="go"
					onClick={handler("/mail/post/on/send")}
					disabled={bind("/mail/sent", (s) => !!s)}
				>
					{bind("/mail/sent", (s) => (s ? "✉️ invites sent" : "✉️ send the invites"))}
				</button>
				<button onClick={handler("on/again")} title="everyone back to undecided">
					new party
				</button>
			</div>
			<div class="row">
				<div class="room">
					<div class="window" />
					<div class="mat">still deciding</div>
					<div class="shelf">can't come, sent love</div>
					<div
						class="table"
						style={bind("seats", (s: Seats) =>
							`left:${CX - s.rx}px;top:${CY - s.ry}px;width:${2 * s.rx}px;height:${
								2 * s.ry
							}px;--leaf:${s.leaves ? (2 * s.rx) / (s.leaves + 2) : 999}px`)}
					>
						{bind("seats", (s: Seats) =>
							s.leaves
								? (
									<span class="leafy" key={`l${s.leaves}`}>
										🔨 {s.leaves === 1 ? "a leaf in!" : `${s.leaves} leaves in!`}
									</span>
								)
								: null)}
					</div>
					{under("./guests", (g) => (
						<div
							class={g.name === "you" ? "guest you" : "guest"}
							style={bind("seats", (s: Seats) => at(s.spots[g.name!]))}
							title={g.name}
						>
							<span class="face">{FACE[g.name!]}</span>
							<span
								class="dish"
								style={bind("seats", (s: Seats) => {
									const p = s.spots[g.name!]
									return p?.where === "table"
										? `left:${p.dx}px;top:${p.dy}px`
										: "display:none"
								})}
							>
								{bind(g.at, (v: Guest) =>
									v.dish ?? "")}
							</span>
							{bind(g.at, (v: Guest) => (v.answer
								? <span class="say" key={`${v.answer}${v.at}`}>{say(v.answer)}</span>
								: null))}
						</div>
					))}
				</div>
				<div class="list">
					<h3>the list</h3>
					{under("./guests", (g) => (
						<div>
							<span>{FACE[g.name!]}</span> {g.name}
							<small>{bind(g.at, (v: Guest) => v.dish ?? "")}</small>
							<b
								class={bind(g.at, (v: Guest) =>
									v.answer ?? "none")}
							>
								{bind(g.at, (v: Guest) => v.answer ?? "?")}
							</b>
						</div>
					))}
					<div class="menu">
						{bind("menu", (m) =>
							!m.any
								? <span>nothing on the table yet</span>
								: m.pudding
								? <span class="ok">🍰 pudding is sorted</span>
								: <span class="warn">nobody's bringing pudding!</span>)}
					</div>
				</div>
			</div>
			<div class="bar">
				are you coming?
				{(["yes", "maybe", "no"] as Answer[]).map((a) => (
					<button
						class={bind("./guests/you", (v: Guest) => (v.answer === a ? "on" : ""))}
						onClick={handler("on/answer", ["you", a])}
					>
						{a}
					</button>
				))}
				<span style="margin-left:10px">bringing</span>
				{DISHES.map((d) => (
					<button
						class={bind("./guests/you", (v: Guest) => (v.dish === d ? "on" : ""))}
						onClick={handler("on/bring", [d])}
					>
						{d}
					</button>
				))}
			</div>
		</div>
	)
}

// the post: brings each reply when its time comes. each reply's
// wait is a promise a memo returns (settled when its time has come), and an effect's act delivers
// it. when the invites went out and how many replies are through are nodes (./sent and ./delivered,
// in the post's own folder), so a reload waits only for the replies not through. a memo reads
// ./delivered untracked: the act writes it, and a memo reading what its own effect writes loops
export function post() {
	const sent = ensureNode("./sent", null)
	const delivered = ensureNode("./delivered", 0)
	const replies = Object.entries(FRIENDS)
		.flatMap(([name, f]) => f.says.map(([ms, answer, dish]) => ({ name, ms, answer, dish })))
		.sort((a, b) => a.ms - b.ms)
	replies.forEach((r, i) => {
		createMemo(`due${i}`, () => {
			const since = read(sent) as number | null
			if (!since || i < get<number>(delivered)) return null
			return new Promise<number>((done) =>
				setTimeout(() => done(since), Math.max(0, r.ms - (Date.now() - since)))
			)
		})
		// the dinner hears it with the post as the caller
		createEffect(`deliver${i}`, () => read(`due${i}`), (since) => {
			if (!since) return
			executeAction("/dinner/on/answer", r.name, r.answer, r.dish)
			patch(delivered, [{ path: [], value: i + 1 }])
		})
	})
	createAction("on/send", () => {
		if (get(sent)) return
		patch(sent, [{ path: [], value: Date.now() }])
		patch(delivered, [{ path: [], value: 0 }])
	})
	createAction("on/reset", () => {
		patch(sent, [{ path: [], value: null }])
		patch(delivered, [{ path: [], value: 0 }])
	})
}
