/** @jsxImportSource ermine-h */
import type { Tools } from "./host.ts"
import { bind } from "ermine-h"

// program.ts: pigs on a field, shared by everyone who opens this example (wss://galaxy.observer).
// edit me while it runs.
//
// try: add a pig, open this in a second window: the same pigs walk the same way in both. pick one
// up: its legs kick, then hang, swinging as you drag; the other window sees it held, by you. go to
// the bottom right corner: a bin comes out; drop a pig in it and it is gone, for everyone (the
// first pig too). drop a pig in the top right corner: it stands there, facing the wall, ashamed,
// until someone picks it up. pick up one pig in both windows at once: the later drag shows. let go
// in both at once: two versions of where it rests, the one in the agreed order shows; settle keeps
// it. add a pig in both at once: two versions of the list, mended to hold both pigs
//
// ---- the format (what another viewer, in C or anything, reads and writes the same way) ----
// ids: ermine://<64 hex>. the room: the host's (ermine://bf04115f9b284145026eab6801219d6e and 32
// zeros, or ?room=). the first pig: FIRST below. a kept node's value table only.
//
// the room's value: {[pig id]: true | false}. true: the pig is in the room; false: it was binned
//   (and stays binned: when versions are mended, false wins). FIRST is in the room unless the room
//   says FIRST: false. a key that isn't a pig id is ignored.
// a pig's stored value: {x, y, at, seed, shame?, binned?}
//   x, y   where its feet were set down, 0 to 1 across and down the field
//   at     when, ms since 1970 (the setter's clock)
//   seed   an integer, 0 to 2^32 - 1: how it wanders
//   shame  true: set down in the corner of shame; it stands at x, y, facing right (the wall),
//          head down, not smiling, and doesn't walk, until picked up again
//   binned true: dropped in the bin; the room's false for it follows
//   missing at: 0. missing seed: hash(id). missing or bad x, y: 0.5. old values {x, y}: as these
// a pig being carried, an ephemeral commit on its node (sync's, on top of the stored value, gone
//   when that device's next stored commit there lands or it goes quiet):
//   {x, y, held: true, by: name, colour: "#rrggbb", who: device key, hex}. x, y: its feet's spot
//   on the ground under it. dropped: one stored commit, {x, y, at: now, seed: new random}, plus
//   shame: true in the corner of shame, or binned: true in the bin (then the room's [id]: false)
// the corner of shame: x > 0.78 and y < 0.45 (field units, where a pig's feet are). a pig let go
//   with its feet there is stored with shame: true. the corner is open while any pig in the room
//   has a stored value with shame: true (the stored one: while it is carried too)
// presence: each device's row at the room (presence's rows, on the channel's topic = the room):
//   {name, colour: "#rrggbb", pointer?: {x, y}, look?, stuck?}; look, a terminal's: "nethack" (its
//   @ is the pointer: drawn here as a small @ tile, and dragged) or "pixels" (an arrow, as a
//   page's). stuck: true, a NetHack player in the corner of shame (drawn dim, sweating): its door
//   lets them in and never out, and a drag that leaves them there sticks them too; they can't leave
//   by themselves, only a page's drag pulls them out
// moving someone (a NetHack player, dragged on a page): JSON messages on the topic "<room>/move",
//   over the same channel, stored nowhere: {to: their key, x, y, by: name, who: my key}, at most
//   once a frame while dragging, then {to, by, who, done: true} at the let go. Their @ goes to the
//   floor cell nearest x, y, through walls (the closet's too, in or out); a pig they carry comes
//   along; their presence row follows, so everyone sees them move
// placed (this device's graph, never synced): /room is the room, /pigs/pig-<id's first 8 hex> each
//   pig in the room
//
// walking, exactly (a resting pig, not ashamed, not binned; the same on every device):
//   hash(id)   FNV-1a, 32 bits, over the id's characters: h = 2166136261; for each c:
//              h = (h ^ c) * 16777619 mod 2^32
//   random(n)  mulberry32 from the 32 bit n: a = n; each draw: a = a + 0x6D2B79F5 mod 2^32;
//              t = a; t = (t ^ t >> 15) * (t | 1); t ^= t + (t ^ t >> 7) * (t | 61);
//              draw = (t ^ t >> 14) / 2^32 (32 bit unsigned, products mod 2^32)
//   draws from random(seed), in this order, each lo + (hi - lo) * draw:
//      1 angle [0, 2π)      2 V [0.012, 0.022)
//      3 kx1 [0.5, 0.9)     4 Tx1 [14, 30)    5 px1 [0, 2π)
//      6 kx2 [0.3, 0.6)     7 Tx2 [6, 12)     8 px2 [0, 2π)
//      9 ky1 [0.35, 0.6)   10 Ty1 [12, 26)   11 py1 [0, 2π)
//     12 ky2 [0.2, 0.4)    13 Ty2 [5, 10)    14 py2 [0, 2π)
//     15 Tp [7, 13)        16 pp [0, 2π)
//   then wi = 2π / Ti, ai = ki / wi (each of x1 x2 y1 y2); wp = 2π / Tp; dx = cos angle,
//   dy = 0.7 sin angle; x0 = x clamped to [0.06, 0.94], y0 = y clamped to [0.22, 0.96]
//   at a time now (ms): t = max(0, (now - at) / 1000); θ = wp t + pp
//     s = t + (2 (sin θ - sin pp) + (sin 2θ - sin 2pp) / 4) / (1.5 wp)   (∫ of g, g below)
//     ux = dx s + ax1 (sin(wx1 s + px1) - sin px1) + ax2 (sin(wx2 s + px2) - sin px2)
//     uy = dy s + ay1 (sin(wy1 s + py1) - sin py1) + ay2 (sin(wy2 s + py2) - sin py2)
//     x = fold(x0 + V ux, 0.06, 0.94), y = fold(y0 + V uy, 0.22, 0.96)
//     fold(v, lo, hi): L = hi - lo; m = ((v - lo) fmod 2L + 2L) fmod 2L; m < L: lo + m, else
//       hi - (m - L) (going back: its velocity's sign flips)
//     then, while the corner of shame is open, if x > 0.78 and y < 0.45: l = x - 0.78,
//       b = 0.45 - y; l < b: x = 0.78 - l (its x velocity's sign flips), else y = 0.45 + b
//   drawing (not agreed, only alike): g = (1 + cos θ)² / 1.5 is how fast it goes now (0: a
//   pause); vx = V (dx + Σ ai wi cos(wi s + pi)) g, times -1 when folded back; it faces right
//   while vx > 0.003, left while vx < -0.003, else as it was; steps at phase 2π 1.6 s, as hard
//   as min(1, g |(du/ds)| / 0.7). look, from random(hash(id)): size 0.86 + 0.24 draw; tint from
//   random(hash(id) ^ 0x9E3779B9): hue 333 + 20 draw, lightness 81 + 6 draw (%)

const FIRST = "ermine://d3b583537595c9a6de0110781d4566d1" + "0".repeat(32)
const W = 110 // a pig's width in px at size 1; its height is 100/130 of it
const LIFT = 26 // px a held pig is lifted above its shadow
// the corner of shame, in field units (its feet): x from 0.78 to 1, y from 0 to 0.45
const SHAME = { x: 0.78, y: 0.45 }
const NEAR = 240 // px from the bottom right corner the bin comes out; from the top right, the corner

// the pig, facing left, in parts: legs (the far two darker) under the body, so their tops hide;
// the tail's start inside the body; the head (ears, their bases under it, face) one part, to hang
const SVG = `<svg class="pig-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 100">
<g stroke="#111" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
<g class="leg"><rect x="49" y="60" width="11" height="30" rx="4" class="deep"/></g>
<g class="leg"><rect x="79" y="60" width="11" height="30" rx="4" class="deep"/></g>
<g class="leg"><rect x="35" y="60" width="11" height="30" rx="4" class="skin"/></g>
<g class="leg"><rect x="94" y="60" width="11" height="30" rx="4" class="skin"/></g>
<g class="tailspot"><path class="tail" d="M105 50 C113 47 120 44 119 37 C118 31 110 32 112 38 C114 43 121 43 125 38" fill="none"/></g>
<ellipse cx="72" cy="56" rx="40" ry="26" class="skin"/>
<g class="head">
<path class="ear l deep" d="M21 32 L15 11 L32 24 Z"/>
<path class="ear r deep" d="M40 24 L56 11 L51 32 Z"/>
<circle cx="36" cy="44" r="22" class="skin"/>
<ellipse cx="19" cy="50" rx="11" ry="9" class="snout"/>
<circle cx="15" cy="50" r="2.2" fill="#111" stroke="none"/>
<circle cx="23" cy="50" r="2.2" fill="#111" stroke="none"/>
<g class="open" fill="#111" stroke="none"><circle cx="31" cy="35" r="3"/><circle cx="47" cy="35" r="3"/></g>
<g class="shut" fill="none" stroke-width="2.5"><path d="M27 37 q4 3 8 0"/><path d="M43 37 q4 3 8 0"/></g>
<path class="smile" d="M28 61 q5 3.5 10 0" fill="none" stroke-width="2.5"/>
<path class="frown" d="M29 58 q4.5 -3.5 9 0" fill="none" stroke-width="2.5"/>
</g>
<path class="sweat" d="M60 14 q-5 7 0 9 q5 -2 0 -9 z" fill="#9fd3f5" stroke-width="2"/>
</g>
</svg>`
// each leg's hip, where it turns: far front, far back, near front, near back
const HIPS = [[54.5, 64], [84.5, 64], [40.5, 64], [99.5, 64]]
// legs stepping together: the near front with the far back, the far front with the near back
const PAIR = [1, 0, 0, 1]
const BIN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 70">
<g stroke="#111" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
<path d="M10 22 L14 64 Q14 67 17 67 L43 67 Q46 67 46 64 L50 22 Z" fill="#fff"/>
<path d="M22 30 L23 59 M30 30 L30 59 M38 30 L37 59" fill="none"/>
<g class="lid"><rect x="5" y="13" width="50" height="8" rx="3" fill="#ffe066"/>
<path d="M23 13 q0 -6 7 -6 q7 0 7 6" fill="none"/></g>
</g></svg>`

const CSS = `
.hacker { position: absolute; transform: translate(-50%, -50%); display: flex;
	flex-direction: column; align-items: center; cursor: grab; touch-action: none; z-index: 9000; }
.hacker.dragged { cursor: grabbing; }
.hacker.stuck .glyph, .hacker.stuck small { opacity: .5; }
.hacker.stuck::after { content: ""; position: absolute; left: 11px; top: -5px; width: 5px; height: 7px;
	background: #9fd3f5; border: 1px solid #111; border-radius: 50% 50% 50% 50% / 30% 30% 70% 70%; }
.hacker .glyph { width: 14px; height: 20px; background: #111; border-radius: 1px;
	font: bold 15px/20px ui-monospace, Menlo, monospace; text-align: center;
	-webkit-font-smoothing: none; font-smooth: never; box-shadow: 0 0 0 1px #000; }
.hacker small { margin-top: 2px; padding: 0 3px; background: #111;
	font: 10px/13px ui-monospace, Menlo, monospace; -webkit-font-smoothing: none; }
.field { position: relative; height: 70vh; border: 1px solid #111; background: #fff8d6;
	overflow: hidden; touch-action: none; user-select: none; }
.pig { position: absolute; left: 0; top: 0; will-change: transform; }
.pig:not([data-ready]), .pig.gone { display: none; }
.pig .shadow { position: absolute; border-radius: 50%; pointer-events: none;
	background: radial-gradient(closest-side, rgba(60, 40, 0, .42), rgba(60, 40, 0, .22) 60%,
		rgba(60, 40, 0, 0));
	transition: transform .2s, opacity .2s; }
.pig.held .shadow { transform: scale(.68); opacity: .5; }
.pig .lift { position: absolute; transition: transform .18s ease-out; cursor: grab; }
.pig.held .lift { transform: translateY(-${LIFT}px); cursor: grabbing; }
.pig.binned .lift { transform: translateY(14px) scale(.12) rotate(30deg); opacity: 0;
	transition: transform .4s ease-in, opacity .4s ease-in; }
.pig.binned .shadow { opacity: 0; }
.pig .sway { width: 100%; height: 100%; transform-origin: 50% 30%; }
.pig .face { width: 100%; height: 100%; transition: transform .25s; }
.pig .face.right { transform: scaleX(-1); }
.pig svg { display: block; width: 100%; height: 100%; }
.pig-svg .skin { fill: var(--pig); } .pig-svg .deep { fill: var(--deep); }
.pig-svg .snout { fill: var(--snout); }
.pig-svg .head, .pig-svg .ear, .pig-svg .tailspot { transition: transform .4s; }
.pig-svg .head { transform-origin: 54px 58px; }
.pig-svg .ear.l { transform-origin: 26px 28px; } .pig-svg .ear.r { transform-origin: 46px 28px; }
.pig-svg .tailspot { transform-origin: 106px 49px; }
.pig-svg .shut, .pig-svg .sweat, .pig-svg .frown { display: none; }
.pig.shame .pig-svg .head { transform: rotate(-22deg) translate(2px, 4px); }
.pig.shame .pig-svg .ear.l { transform: rotate(-62deg); }
.pig.shame .pig-svg .ear.r { transform: rotate(48deg); }
.pig.shame .pig-svg .tailspot { transform: rotate(38deg); }
.pig.shame .pig-svg .open, .pig.shame .pig-svg .smile { display: none; }
.pig.shame .pig-svg .shut, .pig.shame .pig-svg .sweat, .pig.shame .pig-svg .frown {
	display: inline; }
.pig .by { position: absolute; left: 0; transform: translateX(-50%); color: #fff; padding: 0 3px;
	white-space: nowrap; pointer-events: none; font-size: 11px; }
.pig .by:empty { display: none; }
.pig .dots { position: absolute; left: 0; font: bold 16px ui-monospace, Menlo, monospace;
	pointer-events: none; display: none; }
.pig.shame .dots { display: block; }
.bin { position: absolute; right: 12px; bottom: 10px; width: 54px; height: 63px; z-index: 7000;
	pointer-events: none; opacity: 0; transform: translate(30px, 30px) scale(.7);
	transition: transform .22s ease-out, opacity .22s; }
.bin.near { opacity: 1; transform: none; }
.bin svg { display: block; width: 100%; height: 100%; overflow: visible; }
.bin .lid { transform-origin: 52px 17px; transition: transform .15s; }
.bin.open .lid { transform: rotate(28deg) translate(4px, -6px); }
.bin.gulp { animation: gulp .4s; }
@keyframes gulp { 30% { transform: scale(1.12, .9); } 60% { transform: scale(.95, 1.06); } }
.shamecorner { position: absolute; right: 0; top: 0; width: ${(1 - SHAME.x) * 100}%;
	height: ${SHAME.y * 100}%; border-left: 2px dashed rgba(17, 17, 17, .18);
	border-bottom: 2px dashed rgba(17, 17, 17, .18); border-bottom-left-radius: 40px;
	pointer-events: none; opacity: 0; transition: background .2s, opacity .3s; }
.shamecorner.shown { opacity: 1; }
.shamecorner small { position: absolute; right: 6px; top: 4px; color: rgba(17, 17, 17, .4); }
.shamecorner.on { background: rgba(209, 73, 91, .08); }
`

type At = { x: number; y: number }
type Rest = {
	held: false
	x: number
	y: number
	at: number
	seed: number
	shame: boolean
	binned: boolean
}
type Held = { held: true; x: number; y: number; by: string; colour: string; who: string }
type Conflicts = { id: string; versions: number; values: unknown[] }[]

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, or: number) => typeof v === "number" && v === v ? v : or
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const isPig = (k: string) => /^ermine:\/\/[0-9a-f]{64}$/.test(k)
const placeOf = (id: string) => `/pigs/pig-${id.slice(9, 17)}`

// a number from a string (FNV-1a), and numbers from a seed (mulberry32): the same everywhere
function hash(s: string) {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
	return h >>> 0
}
function random(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// ---- walking (the format above): u(s) = start + V (d s + Σ a sin(w s + p)), folded back into
// the field at its edges (a turn). s, the pig's own time, runs at g = (1 + cos θ)² / 1.5 of the
// clock's, 0 now and then (a pause to sniff); its integral is closed, so any time is had at once
type Wave = [a: number, w: number, p: number]
type Path =
	& { x0: number; y0: number; V: number; dx: number; dy: number; wx: Wave[]; wy: Wave[] }
	& { wp: number; pp: number }
const X = [0.06, 0.94], Y = [0.22, 0.96]
function pathOf(r: Rest): Path {
	const n = random(r.seed)
	const range = (lo: number, hi: number) => lo + (hi - lo) * n()
	const wave = (k: number, T: number, p: number): Wave => {
		const w = (2 * Math.PI) / T
		return [k / w, w, p]
	}
	const angle = range(0, 2 * Math.PI)
	const V = range(0.012, 0.022)
	const kx1 = range(0.5, 0.9), Tx1 = range(14, 30), px1 = range(0, 2 * Math.PI)
	const kx2 = range(0.3, 0.6), Tx2 = range(6, 12), px2 = range(0, 2 * Math.PI)
	const ky1 = range(0.35, 0.6), Ty1 = range(12, 26), py1 = range(0, 2 * Math.PI)
	const ky2 = range(0.2, 0.4), Ty2 = range(5, 10), py2 = range(0, 2 * Math.PI)
	const Tp = range(7, 13), pp = range(0, 2 * Math.PI)
	return {
		x0: clamp(r.x, X[0], X[1]),
		y0: clamp(r.y, Y[0], Y[1]),
		V,
		dx: Math.cos(angle),
		dy: Math.sin(angle) * 0.7,
		wx: [wave(kx1, Tx1, px1), wave(kx2, Tx2, px2)],
		wy: [wave(ky1, Ty1, py1), wave(ky2, Ty2, py2)],
		wp: (2 * Math.PI) / Tp,
		pp,
	}
}
// v folded into [lo, hi], and which way it goes there (1, or -1 coming back)
function fold(v: number, lo: number, hi: number): [number, number] {
	const L = hi - lo, m = (((v - lo) % (2 * L)) + 2 * L) % (2 * L)
	return m < L ? [lo + m, 1] : [hi - (m - L), -1]
}
// a point inside the corner of shame, while it is open, folded back out across its nearer inner
// edge (the left, x = 0.78, or the bottom, y = 0.45); which way x goes then (1, or -1 if folded)
function avoid(x: number, y: number): [number, number, number] {
	if (x <= SHAME.x || y >= SHAME.y) return [x, y, 1]
	const left = x - SHAME.x, bottom = SHAME.y - y
	return left < bottom ? [SHAME.x - left, y, -1] : [x, SHAME.y + bottom, 1]
}
function walk(p: Path, at: number, now: number, open: boolean) {
	const t = Math.max(0, (now - at) / 1000)
	const th = p.wp * t + p.pp
	const s = t + (2 * (Math.sin(th) - Math.sin(p.pp)) +
				(Math.sin(2 * th) - Math.sin(2 * p.pp)) / 4) / (1.5 * p.wp)
	const g = (1 + Math.cos(th)) ** 2 / 1.5
	let ux = p.dx * s, uy = p.dy * s, vx = p.dx, vy = p.dy
	for (const [a, w, q] of p.wx) {
		ux += a * (Math.sin(w * s + q) - Math.sin(q)), vx += a * w * Math.cos(w * s + q)
	}
	for (const [a, w, q] of p.wy) {
		uy += a * (Math.sin(w * s + q) - Math.sin(q)), vy += a * w * Math.cos(w * s + q)
	}
	const [x1, fx] = fold(p.x0 + p.V * ux, X[0], X[1])
	const [y1] = fold(p.y0 + p.V * uy, Y[0], Y[1])
	const [x, y, ax] = open ? avoid(x1, y1) : [x1, y1, 1]
	return {
		x,
		y,
		// fractions of the field a second, as walked
		vx: p.V * vx * g * fx * ax,
		// a step a pig-second; how hard it steps (0 still, 1 walking on)
		phase: 2 * Math.PI * 1.6 * s,
		stride: Math.min(1, (g * Math.hypot(vx, vy)) / 0.7),
	}
}

export default function program(t: Tools) {
	// ---- each pig as this device draws it: the parts its frames move, what its node says ----
	type Pig = {
		id: string
		el?: HTMLElement
		lift: HTMLElement
		sway: HTMLElement
		face: HTMLElement
		legs: SVGGElement[]
		tail: SVGGElement
		shadow: HTMLElement
		label: HTMLElement
		dots: HTMLElement
		size: number
		state?: Rest | Held
		path?: Path
		// where it is drawn now (fractions), when it was picked up (performance.now), how it hangs
		g: At
		since: number
		was: boolean
		right: boolean
		x: number
		vx: number
		swing: number
		spin: number
		last: string[]
		ready: boolean
		// its stored value says shame (what it was last set down as, while carried too)
		shamed: boolean
	}
	const pigs = new Map<string, Pig>()
	const template = document.createElement("template")
	template.innerHTML = SVG
	let field: HTMLElement | undefined
	let fw = 1, fh = 1
	const size = new ResizeObserver(([e]) => (fw = e.contentRect.width, fh = e.contentRect.height))
	// someone dragged here (a NetHack player): who, where to, their name; a move due this frame
	let dragging: { who: string; at: At } | undefined
	let moveDue = false
	const moves = `${t.room}/move`
	const moveThem = () => {
		moveDue = false
		if (dragging) t.send(moves, { to: dragging.who, ...dragging.at, by: t.name, who: t.me })
	}
	function drag(e: PointerEvent) {
		const d = dragging!
		d.at = where(e)
		t.pointer(d.at)
		const el = field?.querySelector<HTMLElement>(`.hacker[data-who="${d.who}"]`)
		if (el) el.style.left = `${d.at.x * 100}%`, el.style.top = `${d.at.y * 100}%`
		if (!moveDue) moveDue = true, requestAnimationFrame(moveThem)
	}
	function letGo() {
		const d = dragging!
		dragging = undefined
		field?.querySelector(`.hacker[data-who="${d.who}"]`)?.classList.remove("dragged")
		t.send(moves, { to: d.who, by: t.name, who: t.me, done: true })
	}
	// held here: which pig, where on the pig it was taken (feet minus pointer)
	let holding: { pig: Pig; off: At } | undefined
	let room: Record<string, unknown> = {}
	let firstGone = false

	// the bin, out near the bottom right corner; the corner of shame, top right
	const bin = Object.assign(document.createElement("div"), { className: "bin", innerHTML: BIN })
	const corner = Object.assign(document.createElement("div"), {
		className: "shamecorner",
		innerHTML: "<small>corner of shame</small>",
	})
	const overBin = (e: PointerEvent) => {
		const r = bin.getBoundingClientRect(), m = 26
		return e.clientX > r.left - m && e.clientX < r.right + m && e.clientY > r.top - m &&
			e.clientY < r.bottom + m
	}
	const inShame = (g: At) => g.x > SHAME.x && g.y < SHAME.y
	// carrying a pig near the top right corner: the corner of shame shows
	let nearShame = false
	function corners(p: At | undefined, e?: PointerEvent) {
		const near = p !== undefined && Math.hypot(fw - p.x * fw, fh - p.y * fh) < NEAR
		bin.classList.toggle("near", near)
		bin.classList.toggle("open", near && holding !== undefined && e !== undefined && overBin(e))
		corner.classList.toggle("on", holding !== undefined && inShame(holding.pig.g))
		nearShame = holding !== undefined && p !== undefined &&
			Math.hypot(fw - p.x * fw, p.y * fh) < NEAR
	}
	let gulping: ReturnType<typeof setTimeout> | undefined
	function gulp() {
		bin.classList.remove("gulp")
		void bin.offsetWidth
		bin.classList.add("gulp", "near")
		clearTimeout(gulping)
		gulping = setTimeout(() => bin.classList.remove("gulp", "near"), 900)
	}

	const where = (e: PointerEvent): At => {
		const r = field!.getBoundingClientRect()
		return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
	}
	const div = (cls: string) => Object.assign(document.createElement("div"), { className: cls })

	function pigOf(id: string): Pig {
		const had = pigs.get(id)
		if (had) return had
		const n = random(hash(id))
		const svg = template.content.firstElementChild!.cloneNode(true) as SVGSVGElement
		const lift = div("lift"), sway = div("sway"), face = div("face"), shadow = div("shadow")
		const label = div("by"), dots = div("dots")
		dots.textContent = "…"
		face.append(svg), sway.append(face), lift.append(sway)
		const pig: Pig = {
			id,
			lift,
			sway,
			face,
			legs: [...svg.querySelectorAll<SVGGElement>(".leg")],
			tail: svg.querySelector<SVGGElement>(".tailspot")!,
			shadow,
			label,
			dots,
			size: 0.86 + 0.24 * n(),
			g: { x: 0.5, y: 0.5 },
			since: 0,
			was: false,
			right: false,
			x: 0,
			vx: 0,
			swing: 0,
			spin: 0,
			last: [],
			ready: false,
			shamed: false,
		}
		const w = W * pig.size, h = (w * 100) / 130
		Object.assign(lift.style, { left: `${-w / 2}px`, top: `${-0.9 * h}px`, width: `${w}px` })
		lift.style.height = `${h}px`
		Object.assign(shadow.style, {
			left: `${-w * 0.33}px`,
			top: `${-w * 0.07}px`,
			width: `${w * 0.66}px`,
			height: `${w * 0.14}px`,
		})
		label.style.top = `${-0.9 * h - LIFT - 16}px`
		Object.assign(dots.style, { top: `${-0.9 * h - 12}px`, left: `${w * 0.18}px` })
		lift.addEventListener("pointerdown", (e) => grab(pig, e))
		pigs.set(id, pig)
		return pig
	}
	// its tint, from its id: pink, a little warmer or cooler, lighter or darker
	function tint(pig: Pig, el: HTMLElement) {
		const n = random(hash(pig.id) ^ 0x9e3779b9)
		const hue = 333 + 20 * n(), light = 81 + 6 * n()
		el.style.setProperty("--pig", `hsl(${hue} 80% ${light}%)`)
		el.style.setProperty("--deep", `hsl(${hue} 76% ${light - 6}%)`)
		el.style.setProperty("--snout", `hsl(${hue - 2} 80% ${light - 7}%)`)
	}
	// what its node says now (a binding's): resting, or held by someone
	function note(pig: Pig, v: unknown): string {
		if (!isMap(v)) return ""
		const x = clamp(num(v.x, 0.5)), y = clamp(num(v.y, 0.5))
		if (v.held === true || typeof v.by === "string") {
			const by = String(v.by ?? "someone"), colour = String(v.colour ?? "#888")
			pig.state = { held: true, x, y, by, colour, who: String(v.who ?? "") }
			pig.label.textContent = by
			pig.label.style.background = colour
			return by
		}
		const rest: Rest = {
			held: false,
			x,
			y,
			at: num(v.at, 0),
			seed: num(v.seed, hash(pig.id)),
			shame: v.shame === true,
			binned: v.binned === true,
		}
		pig.shamed = rest.shame
		const was = pig.state
		if (
			was?.held || was?.x !== x || was.y !== y || was.at !== rest.at || was.seed !== rest.seed
		) {
			pig.path = pathOf(rest)
		}
		// someone else binned it: the bin comes out here too
		if (rest.binned && !(was && !was.held && was.binned) && holding?.pig !== pig) gulp()
		pig.state = rest
		pig.label.textContent = ""
		return ""
	}

	// ---- picked up, carried, let go ----
	function grab(pig: Pig, e: PointerEvent) {
		if (holding || !field) return
		try {
			pig.lift.setPointerCapture(e.pointerId)
		} catch { /* a pointer that is not down (a made-up event) */ }
		const p = where(e)
		holding = { pig, off: { x: pig.g.x - p.x, y: pig.g.y - p.y } }
		// the window hears the drag, not the pig: it rises off its shadow, and a capture can be lost
		window.addEventListener("pointermove", follow)
		window.addEventListener("pointerup", follow)
		window.addEventListener("pointercancel", follow)
		carry(e)
	}
	function follow(e: PointerEvent) {
		if (!holding) return
		if (e.type === "pointermove" && e.buttons !== 0) return carry(e)
		drop(e)
	}
	function carry(e: PointerEvent) {
		const p = where(e), h = holding!
		// kept inside the field, lifted pig and all
		const top = (0.9 * W * h.pig.size * 100 / 130 + LIFT + 4) / fh
		h.pig.g = { x: clamp(p.x + h.off.x, 0.03, 0.97), y: clamp(p.y + h.off.y, top, 1) }
		// my pointer goes with the pig, so the others see it there too
		t.pointer(p)
		corners(p, e)
		t.wave(h.pig.id, { ...h.pig.g, held: true, by: t.name, colour: t.colour, who: t.me })
	}
	function drop(e: PointerEvent) {
		window.removeEventListener("pointermove", follow)
		window.removeEventListener("pointerup", follow)
		window.removeEventListener("pointercancel", follow)
		carry(e)
		const pig = holding!.pig, binned = overBin(e)
		holding = undefined
		corners(where(e), e)
		const rest = { ...pig.g, at: Date.now(), seed: Math.floor(Math.random() * 2 ** 32) }
		if (binned) {
			// into the bin: its last place stored (the drag ends everywhere), then out of the room
			const r = bin.getBoundingClientRect(), f = field!.getBoundingClientRect()
			pig.g = {
				x: (r.left + r.width / 2 - f.left) / fw,
				y: (r.top + r.height * 0.4 - f.top) / fh,
			}
			t.store(pig.id, { ...rest, ...pig.g, binned: true })
			gulp()
			setTimeout(() => {
				t.store(t.room, { ...room, [pig.id]: false })
				t.unplace(placeOf(pig.id))
			}, 420)
		} else if (inShame(pig.g)) t.store(pig.id, { ...rest, shame: true })
		else t.store(pig.id, rest)
	}

	// ---- a frame: every pig moved by transforms, nothing written ----
	const put = (pig: Pig, i: number, el: Element, name: string, value: string) => {
		if (pig.last[i] === value) return
		pig.last[i] = value
		if (name === "transform" && el instanceof SVGElement) el.setAttribute("transform", value)
		else (el as HTMLElement).style.setProperty(name, value)
	}
	function step(pig: Pig, now: number, clock: number) {
		const st = pig.state, el = pig.el
		if (!st || !el) return
		if (!pig.ready) el.setAttribute("data-ready", ""), pig.ready = true
		if (pig.id === FIRST) el.classList.toggle("gone", firstGone)
		const mine = holding?.pig === pig
		const held = mine || st.held
		const shame = !held && !st.held && st.shame, binned = !held && !st.held && st.binned
		if (held && !pig.was) pig.since = now
		if (held !== pig.was) el.classList.toggle("held", held), pig.was = held
		el.classList.toggle("shame", shame)
		el.classList.toggle("binned", binned)
		let phase = 0, stride = 0
		if (mine) { /* where the pointer put it */ }
		else if (st.held || st.shame || st.binned) pig.g = { x: st.x, y: st.y }
		else {
			const w = walk(pig.path!, st.at, clock, open)
			pig.g = { x: w.x, y: w.y }
			phase = w.phase, stride = w.stride
			// facing the way it walks; standing about, as it was
			if (Math.abs(w.vx) > 0.003) pig.right = w.vx > 0
		}
		// ashamed: facing the wall
		if (shame) pig.right = true
		// drawn whole inside the field (where it is stays as it is)
		const half = (W * pig.size) / 2 + 2
		const x = Math.min(fw - half, Math.max(half, pig.g.x * fw)), y = pig.g.y * fh
		// how fast it moves across the screen, px a frame, smoothed
		pig.vx += (x - pig.x - pig.vx) * 0.3
		pig.x = x
		put(pig, 0, el, "transform", `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`)
		const z = Math.round(pig.g.y * 1000) + (held ? 8000 : binned ? 6900 : shame ? 3000 : 0)
		put(pig, 1, el, "z-index", String(z))
		pig.face.classList.toggle("right", pig.right)
		const flip = pig.right ? -1 : 1
		let tilt = 0, bob = 0
		const legs: [number, number][] = []
		if (held) {
			// hanging: the legs trail the way it is carried, a spring
			pig.spin += (Math.max(-35, Math.min(35, pig.vx * 4)) - pig.swing) * 0.12
			pig.spin *= 0.82
			pig.swing += pig.spin
			tilt = pig.swing * 0.22
			const since = now - pig.since
			// a kick first, quick, then limp
			const kick = since < 400 ? 1 : Math.max(0, 1 - (since - 400) / 160)
			for (let i = 0; i < 4; i++) {
				const k = 32 * Math.sin(since * 0.075 + i * 1.9)
				const hang = pig.swing * flip + 2.5 * Math.sin(now * 0.003 + i)
				legs.push([kick * k + (1 - kick) * hang, 2.5 * (1 - kick)])
			}
		} else {
			pig.swing = pig.spin = 0
			// ashamed: a slow sigh
			bob = shame ? Math.sin(clock * 0.0025) * 0.8 : -Math.abs(Math.sin(phase)) * 2 * stride
			for (let i = 0; i < 4; i++) {
				legs.push([20 * stride * Math.sin(phase + PAIR[i] * Math.PI), 0])
			}
		}
		put(
			pig,
			2,
			pig.sway,
			"transform",
			`translateY(${bob.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg)`,
		)
		for (let i = 0; i < 4; i++) {
			const [a, d] = legs[i], [hx, hy] = HIPS[i]
			put(
				pig,
				3 + i,
				pig.legs[i],
				"transform",
				`translate(0 ${d.toFixed(1)}) rotate(${a.toFixed(1)} ${hx} ${hy})`,
			)
		}
		const wag = held || shame ? 0 : 8 * Math.sin(clock * 0.006) * stride
		put(pig, 7, pig.tail.firstElementChild!, "transform", `rotate(${wag.toFixed(1)} 106 49)`)
	}
	// the corner is open while any pig in the room was last stored ashamed (carried or not)
	let open = false
	let raf = requestAnimationFrame(function frame(now) {
		const clock = Date.now()
		open = false
		for (const pig of pigs.values()) {
			if (pig.shamed && !(pig.id === FIRST && firstGone)) open = true
		}
		corner.classList.toggle("shown", open || nearShame)
		for (const pig of pigs.values()) step(pig, now, clock)
		raf = requestAnimationFrame(frame)
	})
	t.teardown(() => (cancelAnimationFrame(raf), size.disconnect(), clearTimeout(gulping)))

	// ---- the room: which pigs are in it, placed in this device's graph ----
	const inRoom = (v: unknown, id: string) =>
		isMap(v) ? (id === FIRST ? v[id] !== false : v[id] === true) : id === FIRST
	const others = (v: unknown) =>
		isMap(v) ? Object.keys(v).filter((k) => isPig(k) && k !== FIRST && v[k] === true) : []
	const placed = new Set<string>()
	// placing writes: after the binding that asked has acted
	function place(v: unknown) {
		setTimeout(() => {
			const want = new Set([...others(v), ...(inRoom(v, FIRST) ? [FIRST] : [])])
			for (const id of want) if (!placed.has(id)) placed.add(id), t.place(placeOf(id), id)
			for (const id of placed) {
				if (!want.has(id)) placed.delete(id), t.unplace(placeOf(id))
			}
		}, 0)
	}
	setTimeout(() => t.place("/room", t.room), 0)
	place(undefined)

	function add() {
		const id = t.make()
		const r = random(Math.floor(Math.random() * 2 ** 32))
		t.store(id, {
			x: 0.15 + 0.7 * r(),
			y: 0.3 + 0.6 * r(),
			at: Date.now(),
			seed: Math.floor(r() * 2 ** 32),
		})
		t.store(t.room, { ...room, [id]: true })
	}
	// the list's other versions: a pig added in one is put back, a pig binned in one stays binned;
	// then they are settled. a while first, at random, so two devices rarely both mend at once
	let mending: ReturnType<typeof setTimeout> | undefined
	let conflicts: Conflicts = []
	function mended() {
		const all: Record<string, unknown> = { ...room }
		let changed = false
		for (const v of conflicts.find((c) => c.id === t.room)?.values ?? []) {
			if (!isMap(v)) continue
			for (const k of Object.keys(v)) {
				if (!isPig(k)) continue
				const next = all[k] === false || v[k] === false ? false : true
				if (all[k] !== next) all[k] = next, changed = true
			}
		}
		return changed ? all : undefined
	}
	function mend(cs: Conflicts) {
		conflicts = cs
		if (mending || !mended()) return
		mending = setTimeout(() => {
			mending = undefined
			const all = mended()
			if (all) t.store(t.room, all), t.settle(t.room)
		}, 300 + Math.random() * 1500)
	}
	t.teardown(() => clearTimeout(mending))

	const Pig = ({ id }: { id: string }) => {
		const pig = pigOf(id)
		return (
			<div
				key={id}
				ref={(el: HTMLElement) => {
					// its class is the frames' to change, not h's: set here once
					if (pig.el === el) return
					pig.el = el
					el.className = "pig"
					tint(pig, el)
				}}
				data-by={bind(t.node(id), (v) => note(pig, v))}
			>
				{pig.shadow}
				{pig.lift}
				{pig.label}
				{pig.dots}
			</div>
		)
	}

	return (
		<main style={{ padding: "4px", display: "grid", gap: "4px" }}>
			<style>{CSS}</style>
			<header style={{ display: "flex", gap: "8px", alignItems: "center" }}>
				{bind("/me", (m) => <b style={{ color: m.colour }}>{m.name}</b>)}
				{bind("/me", (m) => <small>server: {m.server}</small>)}
				<button onClick={() => add()}>add a pig</button>
				{bind(
					t.node(t.room),
					(v) => <small>{others(v).length + (inRoom(v, FIRST) ? 1 : 0)} pigs</small>,
				)}
				{bind("/conflicts", (cs: Conflicts) => {
					mend(cs)
					return cs.length
						? (
							<small>
								{cs.length === 1 ? "a node has" : `${cs.length} nodes have`}{" "}
								two versions or more{" "}
								<button onClick={() => cs.forEach((c) => t.settle(c.id))}>settle</button>
							</small>
						)
						: null
				})}
			</header>
			<div
				class="field"
				ref={(el: HTMLElement) => {
					if (field === el) return
					field = el
					size.observe(el)
				}}
				onPointerMove={(e) => {
					if (dragging) return drag(e as PointerEvent)
					if (holding) return
					const p = where(e as PointerEvent)
					t.pointer(p)
					corners(p)
				}}
				onPointerUp={() => dragging && letGo()}
				onPointerCancel={() => dragging && letGo()}
				onPointerLeave={() => holding || dragging || (t.pointer(undefined), corners(undefined))}
			>
				{corner}
				<Pig id={FIRST} />
				{bind(t.node(t.room), (v) => {
					room = isMap(v) ? v : {}
					firstGone = !inRoom(v, FIRST)
					place(v)
					const ids = others(v)
					// a pig gone from the room is let go of here too
					for (const id of pigs.keys()) if (id !== FIRST && !ids.includes(id)) pigs.delete(id)
					return ids.map((id) => <Pig key={id} id={id} />)
				})}
				{bin}
				{bind(
					"/pointers",
					(
						ps: (
							& { who: string; name: string; colour: string; look?: string; stuck?: boolean }
							& At
						)[],
					) =>
						ps.map((p) =>
							p.look === "nethack"
								? (
									// a NetHack player: a small @ tile, theirs to drag (where the drag is, while it is)
									<div
										key={p.who}
										class={`hacker${dragging?.who === p.who ? " dragged" : ""}${
											p.stuck === true ? " stuck" : ""
										}`}
										data-who={p.who}
										style={{
											left: `${(dragging?.who === p.who ? dragging.at : p).x * 100}%`,
											top: `${(dragging?.who === p.who ? dragging.at : p).y * 100}%`,
										}}
										onPointerDown={(e) => {
											const ev = e as PointerEvent
											ev.stopPropagation()
											if (holding || dragging || !field) return
											try {
												field.setPointerCapture(ev.pointerId)
											} catch { /* a made-up event */ }
											;(ev.currentTarget as HTMLElement).classList.add("dragged")
											dragging = { who: p.who, at: where(ev) }
											drag(ev)
										}}
									>
										<span class="glyph" style={{ color: p.colour }}>@</span>
										<small style={{ color: p.colour }}>{p.name}</small>
									</div>
								)
								: (
									<div
										key={p.who}
										style={{
											position: "absolute",
											left: `${p.x * 100}%`,
											top: `${p.y * 100}%`,
											pointerEvents: "none",
											color: p.colour,
											zIndex: "9000",
										}}
									>
										<span style={{ fontSize: "18px" }}>➤</span>
										<small
											style={{ background: p.colour, color: "#fff", padding: "0 3px" }}
										>
											{p.name}
										</small>
									</div>
								)
						),
				)}
			</div>
		</main>
	)
}
