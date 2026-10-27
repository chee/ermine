/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	getArgs,
	list,
	patch,
	peep,
	read,
	unplace,
} from "@ermine/system"
import { change, type Who, who } from "@ermine/slaygrounds/tools"
import { bind, handler, under } from "ermine-h"

// friends-card: a birthday card going round. sign it, or pass it to a friend: the frog, the hedgehog
// and the snail are processes of their own, and each signs from its own timer a while later.
// every signature is a node under ./names. the front grows a flower for each, the inside shows
// its words: two views of the same nodes. who signed is not written in the signature: the card
// reads it off the change that wrote it (who(change): its "caller" and "trusted-event"), so a friend can't
// pretend to be you. edit this file while the snail is crawling: the card keeps every name, and
// the snail keeps crawling

// what the front says: change it while the card is going round
const TITLE = "happy birthday"

// each friend: a face, an ink, how long it takes, what it writes
const FRIENDS = {
	frog: {
		face: "🐸",
		ink: "#40dcba",
		wait: 1800,
		words: ["ribbit!! happy birthday", "hope the pond is warm today"],
	},
	hedgehog: {
		face: "🦔",
		ink: "#2269ff",
		wait: 3500,
		words: ["a careful hug from me", "you are the best. truly"],
	},
	snail: {
		face: "🐌",
		ink: "#ff9b21",
		wait: 14000,
		words: ["sorry it took me a while!!", "happy birthday (last week?)"],
	},
} as const
type Friend = keyof typeof FRIENDS
type Sig = { text: string; tilt: number }

// a signature's colour and label, from who wrote it: you (a person's click in the card), a
// friend (its own process: the caller is named by where it runs, friends/<name>/<name>), or the
// card. a person's click is "trusted-event" on the change, but a write made inside an action the
// click called does not carry it (the call's scope holds only its caller), so the card's own
// writes say "the card" and the change does not say whether a person clicked
const friendOf = (w: Who) => w.caller.split("/").pop() as string
const ink = (w?: Who) =>
	!w
		? "#999"
		: friendOf(w) in FRIENDS
		? FRIENDS[friendOf(w) as Friend].ink
		: w["trusted-event"]
		? "#ff2284"
		: "#888"
const label = (w?: Who) =>
	!w
		? "…"
		: friendOf(w) in FRIENDS
		? `${FRIENDS[friendOf(w) as Friend].face} ${friendOf(w)} · from a timer`
		: w["trusted-event"]
		? "you ✋"
		: "the card · a click or a script, the change does not say"

// the same name always lands in the same spot: a number from its letters
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)!) >>> 0, 7)

// a hand-drawn wobble for the title
const WOBBLE = `<svg width="0" height="0" style="position:absolute"><filter id="wobble">
<feTurbulence baseFrequency="0.035" numOctaves="2" seed="3"/>
<feDisplacementMap in="SourceGraphic" scale="3"/></filter></svg>`

const css = `
body { background: #ffff88; margin: 10px }
.cd { font-family: Jost, system-ui, sans-serif; max-width: 660px; margin: 0 auto }
.cd .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px }
.cd .tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 10px;
	transform: skew(-8deg); font-weight: 600 }
.cd .tag.n { background: #fff; margin-left: auto }
.cd .spread { display: flex; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 0 0 10px 2px #ff228433; height: 290px }
.cd .panel { flex: 1; position: relative; overflow: hidden; background: #fffbea }
.cd .panel + .panel { border-left: 1px dashed #000 }
.cd .front h1 { margin: 18px 0 0; text-align: center; font: 600 34px/1 Jost, sans-serif;
	letter-spacing: 1px; filter: url(#wobble) }
.cd .front h1 span { display: inline-block; color: #ff2284; mix-blend-mode: multiply;
	text-shadow: 3px 2px 0 #2269ff88 }
.cd .front h1 span:nth-child(3n+2) { color: #2269ff; text-shadow: -2px 2px 0 #ff228488 }
.cd .front h1 span:nth-child(3n) { color: #1fb894; text-shadow: 2px -2px 0 #ff9b2188 }
.cd .party h1 span { animation: hop .7s ease-in-out infinite alternate }
${
	[...Array(14)].map((_, i) =>
		`.cd .party h1 span:nth-child(${i + 1}) { animation-delay: ${i * 60}ms }`
	).join("\n")
}
@keyframes hop { to { transform: translateY(-7px) rotate(-6deg) } }
.cd .sub { text-align: center; font-size: 12px; margin-top: 6px; color: #000a }
.cd .ground { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; background: #c8f6ea;
	border-top: 1px solid #000 }
.cd .trail { position: absolute; left: 0; right: 0; bottom: 19px; height: 7px; z-index: 1;
	border-radius: 4px; background: repeating-linear-gradient(90deg, #c9d3ff 0 10px, #fff 10px 13px,
	#b6f0ff 13px 22px) 0 0/44px 7px; box-shadow: 0 0 6px #fff; animation: shine 1.4s linear infinite }
@keyframes shine { to { background-position: 44px 0 } }
.cd .fl { position: absolute; bottom: 21px; width: var(--s); transform-origin: 50% 100%;
	animation: grow 1s cubic-bezier(.3,1.7,.5,1) both }
@keyframes grow { from { transform: scale(0) rotate(-30deg) } }
.cd .fl .head { position: relative; width: var(--s); height: var(--s); transform: rotate(var(--r)) }
.cd .fl .head i { position: absolute; left: 31%; top: 0; width: 38%; height: 50%; background: currentColor;
	border-radius: 50% 50% 40% 40%; transform-origin: 50% 100%; mix-blend-mode: multiply; opacity: .85 }
${
	[0, 1, 2, 3, 4].map((n) =>
		`.cd .fl .head i:nth-child(${n + 1}) { transform: rotate(${n * 72}deg) }`
	).join("\n")
}
.cd .fl .head b { position: absolute; left: 36%; top: 36%; width: 28%; height: 28%; border-radius: 50%;
	background: #ffe800; mix-blend-mode: multiply; transform: translate(1.5px, -1px) }
.cd .fl .stem { margin: -2px auto 0; width: 2px; height: var(--h); background: #000; border-radius: 2px;
	transform: rotate(var(--lean)); transform-origin: 50% 100% }
.cd .crawl { position: absolute; bottom: 18px; font-size: 22px; left: -30px }
.cd .inside { padding: 12px 16px; overflow-y: auto; font-family: Caveat, cursive; font-size: 21px }
.cd .inside p { margin: 0 0 6px; line-height: 1.05 }
.cd .inside p small { display: block; font: 11px Jost, sans-serif; color: #000a; padding-left: 12px }
.cd .inside p small b { display: inline-block; width: 9px; height: 9px; border-radius: 50%;
	border: 1px solid #000; margin-right: 4px; vertical-align: -1px }
.cd .empty { font: 13px Jost, sans-serif; color: #0008; margin-top: 90px; text-align: center }
.cd .bar { display: flex; gap: 6px; margin-top: 10px; align-items: center; flex-wrap: wrap }
.cd input { font: inherit; border: 1px solid #000; border-radius: 2px; padding: 3px 8px; flex: 1;
	min-width: 140px; background: #fff }
.cd button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 2px 10px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform .1s, box-shadow .1s }
.cd button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
.cd button:active { transform: translate(1px, 1px); box-shadow: none }
.cd button.sign { background: #ff2284; color: #fff }
.cd button:disabled { background: #ffffc2; box-shadow: none; transform: none; cursor: wait }
.cd .pass { font-size: 12px; color: #000a }
.cd button.small { font-size: 11px; padding: 0 6px; box-shadow: 1px 1px 0 #000 }
`

// the snail's walk across the front, from when it was handed the card. started once: a reload
// renders this span again (the same element), and a css animation there would keep its own clock
const crawl = (e: HTMLElement, since: number) => {
	if (e.getAnimations().length) return
	e.animate([{ left: "-30px" }, { left: "100%" }], {
		duration: FRIENDS.snail.wait,
		delay: -(Date.now() - since),
		fill: "both",
	})
}

export default function card() {
	ensureNode("./names")

	// a signature: only its words and a tilt. who wrote it is the change's to say
	createAction("on/sign", (text: string) => {
		// a letter first: a name that looks like a number ("773888") jumps to the front of under
		const id = "n" + crypto.randomUUID().slice(0, 5)
		ensureNode(`./names/${id}`, { text, tilt: (hash(id) % 9) - 4 } satisfies Sig)
	})
	createAction("on/clear", () => {
		for (const name of peep(() => list("./names"))) unplace(`./names/${name}`)
	})

	// who wrote each signature: the caller and trusted of the change that made it
	createMemo("who", () => {
		const out: Record<string, Who> = {}
		for (const name of list("./names")) out[name] = who(change(`./names/${name}`))
		return out
	})
	createMemo("count", () => list("./names").length)

	// the words typed, taken out of the input: none, no call
	let input: HTMLInputElement
	const typed = () => {
		const text = input.value.trim()
		input.value = ""
		return text ? [text] : undefined
	}
	return (
		<div class="cd">
			<style>{css}</style>
			<link
				rel="stylesheet"
				href="https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=Jost:wght@400;600&display=swap"
			/>
			<div class="top">
				<span class="tag">a birthday card going round</span>
				<button class="small" onClick={handler("on/clear")} title="every name taken out">
					new card
				</button>
				<span class="tag n">
					🌼 {bind("count", (n) => `${n} signed${n >= 5 ? ", it's a party" : ""}`)}
				</span>
			</div>
			<div class="spread">
				<div class={bind("count", (n) => (n >= 5 ? "panel front party" : "panel front"))}>
					<h1>{[...TITLE].map((c) => <span>{c === " " ? "\u00a0" : c}</span>)}</h1>
					<div class="sub">
						{bind(
							"count",
							(n) => (n ? "a flower for every name" : "the front is bare: sign it"),
						)}
					</div>
					{under("names", (item, i) => {
						// spread by when it came, wobbled by its name
						const h = hash(item.name!)
						const x = 5 + ((i * 0.618 + (h % 13) / 100) % 1) * 82
						return (
							<div
								class="fl"
								style={bind(item, (v: Sig) => {
									const s = Math.min(70, 34 + v.text.length * 1.2)
									return `left:${x}%;--s:${s}px;--h:${50 + (h % 80)}px;--r:${
										h % 72
									}deg;--lean:${v.tilt}deg`
								})}
							>
								<div class="head" style={bind("who", (w) => `color:${ink(w[item.name!])}`)}>
									<i />
									<i />
									<i />
									<i />
									<i />
									<b />
								</div>
								<div class="stem" />
							</div>
						)
					})}
					{bind(
						"/friends/snail/signed",
						(n) => (n ? <div class="trail" title="the snail was here" /> : null),
					)}
					<div class="ground" />
					{bind("/friends/snail/holding", (since) =>
						since
							? (
								<span
									class="crawl"
									ref={(e) => crawl(e, since)}
								>
									🐌
								</span>
							)
							: null)}
				</div>
				<div class="panel inside">
					{bind(
						"count",
						(n) => (n ? null : <div class="empty">nobody has signed yet. be first!</div>),
					)}
					{under("names", (item) => (
						<p style={bind(item, (v: Sig) => `transform:rotate(${v.tilt * 0.4}deg)`)}>
							{bind(item, (v: Sig) =>
								`“${v.text}”`)}
							<small>
								{bind("who", (w) => <b style={`background:${ink(w[item.name!])}`} />)}
								{bind("who", (w) => label(w[item.name!]))}
							</small>
						</p>
					))}
				</div>
			</div>
			<div class="bar">
				<input
					ref={(e) => (input = e)}
					placeholder="write something nice"
					onKeyDown={handler("on/sign", (e) => (e.key === "Enter" ? typed() : undefined))}
				/>
				<button class="sign" onClick={handler("on/sign", typed)}>✍️ sign</button>
				<span class="pass">pass it to</span>
				{(Object.keys(FRIENDS) as Friend[]).map((f) => (
					<button
						onClick={handler(`/friends/${f}/${f}/on/pass`)}
						disabled={bind(`/friends/${f}/holding`, (v) => !!v)}
						title={`${f} signs from a timer of its own`}
					>
						{FRIENDS[f].face} {bind(`/friends/${f}/holding`, (v) => (v ? "writing…" : f))}
					</button>
				))}
			</div>
			{/* jsx here makes html elements only (no svg namespace): the filter goes in as markup */}
			<div ref={(e) => (e.innerHTML = WOBBLE)} />
		</div>
	)
}

// a friend: holds the card for a while, then signs it. the timer is not in the graph, so when the
// card was passed is (./holding, in the friend's own folder): a reload (the timer gone with the old
// run) starts one for what is left. its name is its argument
export function friend() {
	const me = FRIENDS[getArgs()[0] as Friend]
	const holding = ensureNode("./holding", null) // when it was passed, or null
	const signed = ensureNode("./signed", 0)
	// the wait is a promise a memo returns (nothing is open after a timer to write with): it
	// settles with the time the card was passed, and the effect's act signs. a reload runs the memo
	// again from ./holding, so the wait is what is left
	createMemo("arrival", () => {
		const since = read(holding) as number | null
		if (!since) return null
		const left = Math.max(0, me.wait - (Date.now() - since))
		return new Promise<number>((done) => setTimeout(() => done(since), left))
	})
	// the act runs after the timer, in the effect's own scope: it can call the card and write here
	createEffect("sign", () => read("arrival"), (since) => {
		if (!since) return
		const n = peep(() => read(signed)) as number
		executeAction("/card/on/sign", me.words[n % me.words.length])
		patch(signed, [{ path: [], value: n + 1 }])
		patch(holding, [{ path: [], value: null }])
	})
	createAction("on/pass", () => {
		if (peep(() => read(holding))) return
		patch(holding, [{ path: [], value: Date.now() }])
	})
}
