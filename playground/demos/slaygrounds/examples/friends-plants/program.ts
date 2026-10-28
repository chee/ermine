/** @jsxImportSource @ermine */
import {
	createAction,
	createEffect,
	createMemo,
	createWriter,
	ensureNode,
	executeAction,
	patch,
	peep,
	read,
} from "@ermine/system"
import { change, who } from "@ermine/slaygrounds/tools"
import { bind, handler } from "@ermine/render/h"

// friends-plants: the windowsill rota. a day goes by every couple of seconds (the clock, a process
// of its own). each day the plants drink, and it's somebody's turn: yours, the fox's, the frog's.
// click a pot to water it. the fox and the frog are processes too, and water on their own days:
// the fox waters what is thirsty, the frog waters whatever looks driest (the cactus, every time).
// each plant has two nodes: its level (the days and the cans both write it) and poured (only a can
// writes it), so "who watered it" is read off poured's last change (who(change(x))). edit DAY below to make days
// slower: the plants keep their water, only the clock starts again. and send the frog on holiday
// (click it): see what the cactus does when nobody fusses over it
const DAY = 2500 // ms in a day
const POUR = 4 // what a can holds
const PLANTS = {
	fern: { face: "🌿", drinks: 1.5, lo: 2, hi: 9, start: 6 },
	basil: { face: "🌱", drinks: 2.2, lo: 2, hi: 9, start: 6 },
	monstera: { face: "🪴", drinks: 1, lo: 2, hi: 10, start: 6 },
	cactus: { face: "🌵", drinks: 0.8, lo: 0, hi: 4, start: 1 },
}
type Name = keyof typeof PLANTS
const NAMES = Object.keys(PLANTS) as Name[]
const ROTA = ["you", "fox", "frog"]
const MATE: Record<string, string> = { you: "🫵", fox: "🦊", frog: "🐸" }
// a plant's water, and how many days in a row it has had none
type Plant = { level: number; dry: number }
// a pour: the day, and when (so two pours on one day are two changes)
type Pour = { day: number; at: number }
type Poured = { day: number; by: string } | null

// how a plant is doing. the cactus flowers when it's left alone long enough
const mood = (name: Name, v: Plant) => {
	const p = PLANTS[name]
	if (v.level > p.hi) return "drowning"
	if (name === "cactus" && v.dry >= 4) return "blooming"
	if (v.level <= 0 && p.lo > 0) return "wilted"
	if (v.level < p.lo) return "thirsty"
	return "happy"
}
const FACES = { happy: "◕‿◕", thirsty: "ˇ﹏ˇ", wilted: "×﹏×", drowning: "°□°", blooming: "♥‿♥" }

const css = `
body { background: #ffff88; margin: 10px }
.pl { font-family: Jost, system-ui, sans-serif; max-width: 680px; margin: 0 auto }
.pl .top { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap }
.pl .tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 10px;
	transform: skew(-8deg); font-weight: 600; white-space: nowrap }
.pl .fill { flex: 1 }
.pl button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 1px 9px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform .1s, box-shadow .1s }
.pl button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
.pl button:active { transform: translate(1px, 1px); box-shadow: none }
.pl .mate.duty { background: #ff2284; color: #fff }
.pl .mate.away { background: #d4e4ff; text-decoration: line-through }
.pl .mate.duty.you { animation: nudge .8s ease-in-out infinite alternate }
@keyframes nudge { to { transform: translateY(-3px) rotate(-2deg) } }
.pl .room { position: relative; height: 300px; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 0 0 10px 2px #ff228433; overflow: hidden }
.pl .window { position: absolute; left: 40px; right: 40px; top: 10px; height: 120px; border: 1.5px solid #000;
	background: linear-gradient(#d4e4ff, #fffbea); overflow: hidden }
.pl .window::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; border-left: 1.5px solid #000 }
.pl .window::after { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 1.5px solid #000 }
.pl .sun { position: absolute; top: 40px; left: -30px; width: 34px; height: 34px; border-radius: 50%;
	background: #ffe800; mix-blend-mode: multiply; box-shadow: 0 0 0 5px #ffe80066;
	animation: across var(--day) linear both }
@keyframes across { 0% { left: -30px; top: 76px } 50% { top: 12px } 100% { left: 100%; top: 76px } }
.pl .daynum { position: absolute; right: 8px; top: 4px; z-index: 1; font-weight: 600; font-size: 13px;
	background: #fff; border: 1px solid #000; padding: 0 6px; transform: skew(-8deg) }
.pl .sill { position: absolute; left: 14px; right: 14px; top: 222px; height: 10px; background: #fff;
	border: 1.5px solid #000; border-radius: 2px; box-shadow: 0 4px 0 #ff228444 }
.pl .pots { position: absolute; left: 30px; right: 30px; top: 42px; display: flex; justify-content: space-around }
.pl .pot { position: relative; width: 120px; height: 180px; cursor: pointer }
.pl .plant { position: absolute; left: 50%; bottom: 60px; font-size: 56px; line-height: 1;
	transform-origin: 50% 100%; transform: translateX(-50%); transition: transform .6s, filter .6s }
.pl .thirsty .plant { transform: translateX(-50%) rotate(-12deg); filter: saturate(.5) }
.pl .wilted .plant { transform: translateX(-50%) rotate(-38deg) scale(.9); filter: grayscale(1) brightness(1.1) }
.pl .drowning .plant { animation: bob .9s ease-in-out infinite alternate }
@keyframes bob { from { transform: translateX(-50%) rotate(-4deg) } to { transform: translateX(-50%) rotate(4deg) } }
.pl .bloom { position: absolute; left: 50%; bottom: 108px; font-size: 26px; transform: translateX(-30%);
	animation: open 1.2s cubic-bezier(.3,1.7,.5,1) both }
@keyframes open { from { transform: translateX(-30%) scale(0) rotate(-90deg) } }
.pl .clay { position: absolute; left: 50%; bottom: 0; width: 70px; height: 62px; margin-left: -35px;
	background: #ff7a59; border: 1.5px solid #000; border-radius: 4px 4px 14px 14px;
	clip-path: polygon(0 0, 100% 0, 88% 100%, 12% 100%); display: grid; place-items: center;
	font: 600 15px Jost, sans-serif; color: #000 }
.pl .clay::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 14px; background: #ff9c80;
	border-bottom: 1.5px solid #000 }
.pl .puddle { position: absolute; left: 50%; bottom: -6px; z-index: 1; width: 120px; height: 14px; margin-left: -60px;
	border-radius: 50%; background: #2269ff55; animation: spread .6s both }
@keyframes spread { from { transform: scaleX(.2) } }
.pl .gauge { position: absolute; left: 14px; right: 14px; bottom: -42px; height: 8px; border: 1px solid #000;
	border-radius: 4px; background: #fff; overflow: hidden }
.pl .gauge .ok { position: absolute; top: 0; bottom: 0; background: #40dcba66 }
.pl .gauge .lvl { position: absolute; left: 0; top: 0; bottom: 0; background: #2269ff; transition: width .5s }
.pl .who { position: absolute; left: -14px; right: -14px; bottom: -60px; text-align: center; font-size: 11px;
	color: #000a; white-space: nowrap }
.pl .name { position: absolute; left: 0; right: 0; bottom: -28px; text-align: center; font-size: 11px; font-weight: 600 }
.pl .splash { position: absolute; left: 50%; top: 20px; font-size: 20px; animation: drip .8s both; pointer-events: none }
@keyframes drip { from { opacity: 1; transform: translate(-50%, -20px) } to { opacity: 0; transform: translate(-50%, 40px) } }
`

// a node's value now, from an action or an act (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0]) => peep(() => read(x)) as T
const put = (x: Parameters<typeof read>[0], value: unknown) => patch(x, [{ path: [], value }])

export default function sill() {
	const day = ensureNode("./day", 1)
	const away = ensureNode("./away", [] as string[])
	const level = {} as Record<Name, ReturnType<typeof ensureNode>>
	const poured = {} as Record<Name, ReturnType<typeof ensureNode>>
	for (const name of NAMES) {
		level[name] = ensureNode(
			`./plants/${name}/level`,
			{ level: PLANTS[name].start, dry: 0 } satisfies Plant,
		)
		poured[name] = ensureNode(`./plants/${name}/poured`, null) // the day it was last watered
	}

	createMemo("duty", () => ROTA[(read(day) as number) % ROTA.length])

	// who watered each plant last: the caller on poured's latest change (the days never write it).
	// the caller "sill" is a click on a pot: the change does not say "trusted-event" (a write made
	// inside an action does not carry it), and the pots are all the sill has that calls on/water
	createMemo("who", () => {
		const out: Record<string, Poured> = {}
		for (const name of NAMES) {
			const when = (read(poured[name]) as Pour | null)?.day ?? null
			const by = who(change(`./plants/${name}/poured`))
			out[name] = when === null ? null : {
				day: when,
				by: by.caller === "sill" ? "you" : by.caller,
			}
		}
		return out
	})

	// a new day: every plant drinks, a puddle dries a bit. whoever's turn it is notices (the fox and
	// the frog read the duty memo)
	createAction("on/day", () => {
		put(day, get<number>(day) + 1)
		for (const name of NAMES) {
			const v = get<Plant>(level[name])
			const p = PLANTS[name]
			const drink = p.drinks + (v.level > p.hi ? 2 : 0)
			const left = Math.max(0, Math.round((v.level - drink) * 10) / 10)
			patch(level[name], [
				{ path: ["level"], value: left },
				{ path: ["dry"], value: left === 0 ? v.dry + 1 : 0 },
			])
		}
	})
	createAction("on/water", (name: Name) => {
		const v = get<Plant>(level[name])
		patch(level[name], [
			{ path: ["level"], value: v.level + POUR },
			{ path: ["dry"], value: 0 },
		])
		put(poured[name], { day: get<number>(day), at: Date.now() } satisfies Pour)
	})
	createAction("on/holiday", (mate: string) => {
		const list = get<string[]>(away)
		put(away, list.includes(mate) ? list.filter((m) => m !== mate) : [...list, mate])
	})

	return (
		<div class="pl">
			<style>{css}</style>
			<link
				rel="stylesheet"
				href="https://fonts.googleapis.com/css2?family=Jost:wght@400;600&display=swap"
			/>
			<div class="top">
				<span class="tag">windowsill rota</span>
				<span>on duty:</span>
				{ROTA.map((m) => (
					<button
						class={bind("duty", (d) => `mate ${m}${d === m ? " duty" : ""}`)}
						onClick={m === "you" ? undefined : handler("on/holiday", [m])}
						title={m === "you"
							? "that's you: click a pot to water it"
							: "send on holiday (or bring back)"}
					>
						{MATE[m]} {m}
						{m === "you"
							? null
							: bind("./away", (a: string[]) => (a.includes(m) ? " 🏖" : ""))}
					</button>
				))}
				<span class="fill" />
				<button onClick={handler("/clock/on/toggle")}>
					{bind("/running", (r) => (r ? "⏸ pause the days" : "▶ let days go by"))}
				</button>
			</div>
			<div class="room">
				<div class="window">
					{bind("./day", (d) => <span class="sun" key={`d${d}`} style={`--day:${DAY}ms`} />)}
				</div>
				<span class="daynum">day {bind("./day")}</span>
				<div class="sill" />
				<div class="pots">
					{NAMES.map((name) => {
						const p = PLANTS[name]
						const at = `./plants/${name}/level`
						return (
							<div
								class={bind(at, (v: Plant) => `pot ${mood(name, v)}`)}
								onClick={handler("on/water", [name])}
								title={`water the ${name}`}
							>
								{bind(
									at,
									(
										v: Plant,
									) => (mood(name, v) === "drowning" ? <div class="puddle" /> : null),
								)}
								<span class="plant">{p.face}</span>
								{bind(
									at,
									(
										v: Plant,
									) => (mood(name, v) === "blooming"
										? <span class="bloom">🌸</span>
										: null),
								)}
								<div class="clay">{bind(at, (v: Plant) => FACES[mood(name, v)])}</div>
								{bind(
									`./plants/${name}/poured`,
									(d: Pour | null) =>
										d === null ? null : <span class="splash" key={`s${d.at}`}>💧</span>,
								)}
								<div class="name">{name}</div>
								<div class="gauge">
									<i
										class="ok"
										style={`left:${(p.lo / 14) * 100}%;width:${
											((p.hi - p.lo) / 14) * 100
										}%`}
									/>
									<i
										class="lvl"
										style={bind(
											at,
											(v: Plant) => `width:${Math.min(100, (v.level / 14) * 100)}%`,
										)}
									/>
								</div>
								<div class="who">
									{bind("who", (w) =>
										w[name]
											? `${MATE[w[name].by] ?? "🤖"} watered it, day ${w[name].day}`
											: "not watered yet")}
								</div>
							</div>
						)
					})}
				</div>
			</div>
		</div>
	)
}

// the clock: a day every DAY ms. an effect runs a setInterval while running (the clock's own
// node) is on, and each tick calls on/beat through a writer made in setup. a pause clears the
// timer
export function clock() {
	const running = ensureNode("./running", true)
	createAction("on/toggle", () => put(running, !get<boolean>(running)))
	createAction("on/beat", () => executeAction("/sill/on/day"))
	const withWriter = createWriter()
	createEffect("beat", () => read(running), (on) => {
		if (!on) return
		const t = setInterval(() => withWriter(() => executeAction("on/beat")), DAY)
		return () => clearInterval(t)
	})
}

// a housemate on duty: told by the duty memo, not knocked on. the first duty seen is the one it
// woke to (a reload does not water again), and a day on holiday is skipped
function onduty(me: string, morning: () => void) {
	let seen: unknown
	createEffect("turn", () => read("/sill/duty"), (duty) => {
		const first = seen === undefined
		seen = duty
		if (first || duty !== me) return
		if (get<string[]>("/away").includes(me)) return
		morning()
	})
}

// the fox: careful. waters what is thirsty, and leaves the cactus alone
export function fox() {
	onduty("fox", () => {
		for (const name of NAMES) {
			if (name === "cactus") continue
			const v = get<Plant>(`/plants/${name}/level`)
			if (v.level < PLANTS[name].lo + 2) executeAction("/sill/on/water", name)
		}
	})
}

// the frog: loves water. waters whatever looks driest, which is always the cactus. twice
export function frog() {
	onduty("frog", () => {
		executeAction("/sill/on/water", "cactus")
		executeAction("/sill/on/water", "cactus")
	})
}
