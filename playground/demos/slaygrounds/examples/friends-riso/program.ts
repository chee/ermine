/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, type Bound, type Child, handler, under } from "ermine-h"

// friends-riso: a riso poster for the picnic. type the words, press print. three drums (yellow,
// blue, pink) each lay their ink down a little off from the others, a new wobble every copy.
// what the machine did is in nodes: each drum's offset and the ink left in it (./drums/*), and
// every copy printed (./prints/*, each keeping the inks it was printed with). what the inks
// look like is in this file. change a colour below while it runs: the proof and the next copies
// come out in the new colour, the stack keeps the old ones, and no drum gets any fuller. keep
// printing and a drum runs dry
const INKS = {
	yellow: { colour: "#ffe800", cost: 13 },
	blue: { colour: "#0078bf", cost: 7 },
	pink: { colour: "#ff48b0", cost: 9 },
}
type Ink = keyof typeof INKS
const DRUMS = Object.keys(INKS) as Ink[]
type Drum = { on: boolean; dx: number; dy: number; ink: number }
type Layer = { name: Ink; colour: string; dx: number; dy: number; strength: number }
type Copy = { words: string; layers: Layer[]; tilt: number }

// a layer's look: its ink, where it landed, how much ink it had. low ink comes out in speckles
const patchy = (s: number) =>
	s >= 1
		? ""
		: s <= 0
		? "opacity:0;"
		: `opacity:${(0.45 + s * 0.55).toFixed(2)};-webkit-mask-image:radial-gradient(#000 ${
			Math.round(25 + s * 40)
		}%,transparent ${Math.round(28 + s * 40)}%);-webkit-mask-size:4px 4px;`
const look = (colour: string, dx: number, dy: number, strength: number) =>
	`--c:${colour};transform:translate(${dx}px,${dy}px);${patchy(strength)}`
// the biggest letters that fit the sheet: 222px wide, 140px tall for the words, wrapped by word
const size = (w: string) => {
	const words = w.toUpperCase().split(/\s+/).filter(Boolean)
	for (let px = 72; px > 22; px -= 2) {
		const fits = Math.floor(222 / (px * 0.68)) // letters to a line
		let lines = 1, line = 0
		for (const word of words) {
			if (word.length > fits) lines = 99
			else if (line && line + 1 + word.length > fits) (lines++, line = word.length)
			else line += (line ? 1 : 0) + word.length
		}
		if (lines * px * 0.92 <= 140) return `font-size:${px}px`
	}
	return "font-size:22px"
}

// one sheet of paper: the three inks laid down, each its own layer. the proof binds each layer to
// its drum; a copy in the stack draws the same sheet from what it kept
function Sheet(p: { words: Child; size: string | Bound; layer: (name: Ink) => string | Bound }) {
	return (
		<div class="sheet">
			<div class="layer" style={p.layer("yellow")}>
				<div class="sun" />
			</div>
			<div class="layer" style={p.layer("blue")}>
				<div class="words dots" style={p.size}>{p.words}</div>
				<div class="stars">✦ ✦ ✦ ✦ ✦ ✦</div>
			</div>
			<div class="layer" style={p.layer("pink")}>
				<div class="words" style={p.size}>{p.words}</div>
				<div class="when">sat · 3pm · the big tree</div>
			</div>
			<div class="grain" />
		</div>
	)
}

const css = `
body { background: #ffff88; margin: 10px }
.rp { font-family: Jost, system-ui, sans-serif; max-width: 680px; margin: 0 auto }
.rp .top { display: flex; gap: 6px; align-items: center; margin-bottom: 8px }
.rp .tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 10px;
	transform: skew(-8deg); font-weight: 600; white-space: nowrap }
.rp input { font: inherit; border: 1px solid #000; border-radius: 2px; padding: 3px 8px; flex: 1;
	min-width: 0; background: #fff }
.rp button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 2px 10px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform .1s, box-shadow .1s }
.rp button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
.rp button:active { transform: translate(1px, 1px); box-shadow: none }
.rp button.go { background: #ff2284; color: #fff; font-weight: 600 }
.rp .row { display: flex; gap: 12px; align-items: flex-start }
.rp .proof { flex: none; position: relative; padding: 8px; background: #fff; border: 1px solid #000;
	border-radius: 2px; box-shadow: 0 0 10px 2px #ff228433 }
.rp .proof .label { position: absolute; top: -9px; left: 10px; z-index: 2; font-size: 11px; background: #fff;
	border: 1px solid #000; padding: 0 6px; transform: skew(-8deg) }
.sheet { position: relative; width: 250px; height: 330px; background: #fbf3e2; overflow: hidden }
.sheet .layer { position: absolute; inset: 0; mix-blend-mode: multiply;
	transition: transform .4s cubic-bezier(.3,1.6,.5,1), opacity .4s }
.sheet .sun { position: absolute; left: 50%; top: 26px; width: 150px; height: 150px; margin-left: -75px;
	border-radius: 50%; background: var(--c);
	box-shadow: 0 0 0 10px #fbf3e2, 0 0 0 16px var(--c) }
.sheet .words { position: absolute; left: 14px; right: 14px; top: 118px; font-weight: 600; line-height: .9;
	text-transform: uppercase; color: var(--c); overflow-wrap: anywhere; letter-spacing: -1px }
.sheet .words.dots { color: transparent; background: radial-gradient(circle, var(--c) 1.3px, transparent 1.7px)
	0 0/4px 4px; -webkit-background-clip: text; background-clip: text; transform: translate(5px, 5px) }
.sheet .stars { position: absolute; left: 0; right: 0; bottom: 46px; text-align: center; color: var(--c);
	letter-spacing: 6px; font-size: 18px }
.sheet .when { position: absolute; left: 0; right: 0; bottom: 18px; text-align: center; color: var(--c);
	font-weight: 600; font-size: 15px; letter-spacing: 1px }
.sheet .grain { position: absolute; inset: 0; pointer-events: none; mix-blend-mode: multiply; opacity: .5;
	background: radial-gradient(#0002 .6px, transparent .9px) 0 0/3px 3px,
		radial-gradient(#0001 .6px, transparent .9px) 1px 2px/5px 5px }
.rp .side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px }
.rp .drums { background: #fff; border: 1px solid #000; border-radius: 2px; box-shadow: 0 0 10px 2px #ff228433 }
.rp .drum { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-top: 1px solid #0002 }
.rp .drum:first-child { border-top: 0 }
.rp .drum .ink { width: 76px; text-align: left; background: var(--c); font-weight: 600 }
.rp .drum.off .ink { background: #fff; color: #0006; text-decoration: line-through }
.rp .drum.dry { animation: cough .5s 2 }
@keyframes cough { 25% { transform: translateX(-5px) rotate(-1deg) } 75% { transform: translateX(5px) rotate(1deg) } }
.rp .mark { position: relative; flex: none; width: 30px; height: 30px; border: 1px dashed #0003 }
.rp .mark i { position: absolute; left: 7px; top: 7px; width: 16px; height: 16px; border-radius: 50%;
	border: 1.5px solid #000; transition: transform .4s }
.rp .mark i::before, .rp .mark i::after { content: ""; position: absolute; background: inherit; left: 50%; top: -5px;
	bottom: -5px; width: 1.5px; margin-left: -.75px; background: currentColor }
.rp .mark i::after { left: -5px; right: -5px; top: 50%; bottom: auto; width: auto; height: 1.5px; margin: -.75px 0 0 }
.rp .mark i.c { border-color: var(--c); color: var(--c); mix-blend-mode: multiply }
.rp .mark i.k { color: #000 }
.rp .gauge { flex: 1; height: 10px; border: 1px solid #000; border-radius: 6px; overflow: hidden; background: #fff }
.rp .gauge i { display: block; height: 100%; background: var(--c); transition: width .3s }
.rp .drum small { width: 72px; font-size: 11px; color: #000a; font-variant-numeric: tabular-nums }
.rp .drum .refill { font-size: 11px; padding: 0 6px; box-shadow: 1px 1px 0 #000 }
.rp .stack { position: relative; background: #fff; border: 1px solid #000; border-radius: 2px; height: 128px;
	box-shadow: 0 0 10px 2px #ff228433; overflow: hidden }
.rp .stack .label { position: absolute; left: 8px; top: 4px; font-size: 11px; color: #000a; z-index: 2 }
.rp .stack .pile { position: absolute; left: 8px; right: 8px; bottom: 6px; top: 20px; display: flex;
	justify-content: flex-end; align-items: flex-end }
.rp .copy { flex: none; width: 66px; height: 87px; margin-left: -34px; border: 1px solid #0004;
	box-shadow: 1px 2px 4px #0003; overflow: hidden; background: #fbf3e2; animation: out .5s ease-out both }
@keyframes out { from { transform: translateY(-60px) rotate(0) } }
.rp .copy .sheet { transform: scale(.264); transform-origin: 0 0 }
.rp .copy:hover { z-index: 3; outline: 2px solid #ff2284 }
.rp .empty { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; color: #0008 }
`

export default function program({ open, read, edit, remove, list, memo, method }: API) {
	const words = open("./words", "picnic!")
	const drum = Object.fromEntries(
		DRUMS.map((
			n,
		) => [n, open(`./drums/${n}`, { on: true, dx: 0, dy: 0, ink: 100 } satisfies Drum)]),
	) as Record<Ink, ReturnType<typeof open>>
	open("./prints")
	const prints = () => list("./prints")
	memo("count", () => prints().length)

	const wobble = () => Math.round((Math.random() - 0.5) * 12)
	method("on/words", (w: string) => edit(words, () => w))
	// a copy: each drum that is on lays its ink down somewhere a little new, and uses some up
	method("on/print", () => {
		const layers: Layer[] = []
		for (const name of DRUMS) {
			const d = read(drum[name]) as Drum
			if (!d.on) continue
			const { colour, cost } = INKS[name]
			const dx = wobble(), dy = wobble(), ink = Math.max(0, d.ink - cost)
			edit(drum[name], (x: Drum) => {
				x.dx = dx
				x.dy = dy
				x.ink = ink
			})
			layers.push({ name, colour, dx, dy, strength: d.ink / cost })
		}
		// named in order, so the stack is too
		const n = String(prints().length + 1).padStart(4, "0")
		const tilt = Math.round((Math.random() - 0.5) * 14)
		open(`./prints/copy${n}`, { words: read(words) as string, layers, tilt } satisfies Copy)
	})
	method("on/toggle", (name: Ink) => edit(drum[name], (d: Drum) => void (d.on = !d.on)))
	method("on/refill", (name: Ink) => edit(drum[name], (d: Drum) => void (d.ink = 100)))
	method("on/recycle", () => {
		for (const name of prints()) remove(`./prints/${name}`)
	})

	// the proof: the sheet as the drums are now (where the last copy landed, the ink left)
	const proof = (name: Ink) =>
		bind(
			`drums/${name}`,
			(d: Drum) =>
				d.on ? look(INKS[name].colour, d.dx, d.dy, d.ink / INKS[name].cost) : "opacity:0;",
		)
	// a copy: the sheet as it came out
	const kept = (c: Copy) => (name: Ink) => {
		const l = c.layers.find((x) => x.name === name)
		return l ? look(l.colour, l.dx, l.dy, l.strength) : "opacity:0;"
	}

	return (
		<div class="rp">
			<style>{css}</style>
			<link
				rel="stylesheet"
				href="https://fonts.googleapis.com/css2?family=Jost:wght@400;600&display=swap"
			/>
			<div class="top">
				<span class="tag">riso shop</span>
				<input
					value={bind("words")}
					maxLength={40}
					placeholder="what does the poster say?"
					onInput={handler("on/words", (e) => [e.target.value])}
				/>
				<button class="go" onClick={handler("on/print")}>🖨 print</button>
			</div>
			<div class="row">
				<div class="proof">
					<span class="label">proof</span>
					<Sheet words={bind("words")} size={bind("words", size)} layer={proof} />
				</div>
				<div class="side">
					<div class="drums">
						{DRUMS.map((n) => (
							<div
								class={bind(
									`drums/${n}`,
									(d: Drum) => `drum${d.on ? "" : " off"}${d.ink <= 0 ? " dry" : ""}`,
								)}
								style={`--c:${INKS[n].colour}`}
							>
								<button
									class="ink"
									onClick={handler("on/toggle", [n])}
									title="turn this drum on or off"
								>
									{n}
								</button>
								<div class="mark" title="where this ink lands, against the black">
									<i class="k" />
									<i
										class="c"
										style={bind(
											`drums/${n}`,
											(d: Drum) => `transform:translate(${d.dx}px,${d.dy}px)`,
										)}
									/>
								</div>
								<div class="gauge">
									<i style={bind(`drums/${n}`, (d: Drum) => `width:${d.ink}%`)} />
								</div>
								<small>
									{bind(
										`drums/${n}`,
										(d: Drum) => (d.ink <= 0 ? "dry! 🫠" : `${d.ink}% left`),
									)}
								</small>
								<button class="refill" onClick={handler("on/refill", [n])}>refill</button>
							</div>
						))}
					</div>
					<div class="stack">
						<span class="label">
							the stack · {bind("count", (n) => `${n} ${n === 1 ? "copy" : "copies"}`)}{" "}
							<button class="refill" onClick={handler("on/recycle")}>♻ recycle</button>
						</span>
						{bind(
							"count",
							(n) => (n ? null : <div class="empty">press print: copies land here</div>),
						)}
						<div class="pile">
							{under("prints", (copy) => (
								<div
									class="copy"
									style={bind(copy, (c: Copy) => `rotate:${c.tilt}deg`)}
								>
									{bind(
										copy,
										(c: Copy) => (
											<Sheet words={c.words} size={size(c.words)} layer={kept(c)} />
										),
									)}
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
