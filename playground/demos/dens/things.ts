// the things: one runner each, given the den's Start (the box, places, process, scheduler...). a thing
// writes what it gives on its own process node, attributes["thing.out"], and reads its sources the
// same way: their nodes' attributes, here or mirrored from away. its args say what it reads, as
// triples [input, den id, path] (a counter's input is "in", a pig's its name; the path where the
// source runs: here, or as away places another den's process), and any settings as "name=value"
// (the pigs' weights to start at). by path, so a source started again is followed
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import { get } from "@ermine/places/lib"
import { inside } from "@ermine/boxes"
import type { Runner, Start } from "@ermine/dens"

// a runner here is its start alone: (code, start)
type Run = Runner["start"]
type Context = Start

const OUT = "thing.out"
// a timer's every and paused, beside its out
export const STATE = "thing.state"

export type Source = { input: string; den: string; at: string }
// what args say: the sources, and the settings
export function parse(
	args: readonly string[],
): { sources: Source[]; settings: Record<string, string> } {
	const sources: Source[] = [], settings: Record<string, string> = {}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		const eq = a.indexOf("=")
		if (eq !== -1) settings[a.slice(0, eq)] = a.slice(eq + 1)
		else if (i + 2 < args.length) {
			sources.push({ input: a, den: args[i + 1], at: args[i + 2] })
			i += 2
		}
	}
	return { sources, settings }
}
export function unparse(sources: readonly Source[], settings: Record<string, string> = {}) {
	return [
		...sources.flatMap((s) => [s.input, s.den, s.at]),
		...Object.entries(settings).map(([k, v]) => `${k}=${v}`),
	]
}

// what the page can do to a thing running here: press it, feed a pig, type on the keys, draw on a pad
export type Control = {
	press?: () => void
	feed?: (pig: string) => void
	type?: (key: string) => void
	every?: (seconds: number) => void
	pause?: () => void
	// a pad: one square set (on) or cleared; all cleared; its squares as drawn here, and what is
	// drawn under them, now (its out lags a little behind)
	draw?: (x: number, y: number, on: boolean) => void
	clear?: () => void
	now?: () => { mine: Picture; under?: Picture }
}

// a picture: squares on or off, width across and height down, as bytes, row after row, the first
// square of each byte its top bit. a pad's is 48 by 27: the cardputer's screen, 5 pixels a square
export type Picture = { width: number; height: number; squares: Uint8Array }
export const PAD = { width: 48, height: 27 }
export const isPicture = (v: unknown): v is Picture =>
	v !== null && typeof v === "object" && (v as Picture).squares instanceof Uint8Array &&
	Number.isInteger((v as Picture).width) && Number.isInteger((v as Picture).height) &&
	(v as Picture).squares.length * 8 >= (v as Picture).width * (v as Picture).height
export function square(p: Picture, x: number, y: number): boolean {
	const i = y * p.width + x
	return ((p.squares[i >> 3] >> (7 - (i & 7))) & 1) === 1
}
export const controls = new Map<string, Control>()
// what a sound thing plays through: the page's (its mute), set by the page
export const speaker = { play: (_note: string, _freq: number) => {} }
// what the pigs were told to say, beside their out
export const SAYS = "thing.says"

// its out (or another attribute of its node), written with its scope open
function writer(ctx: Context, name = OUT) {
	const s = ctx.scheduler
	return (v: unknown) =>
		s.runWithScope(ctx.scope, () =>
			ctx.places.commit(
				upsert(ctx.table, "attributes", ctx.process.id, [name], v, createChangeHeader(s)),
			))
}

// the out of what is wired into input, tracked (the path, then the node there): f told each value;
// first: the first, or the first from a node now at that path (a source started again)
function reading(ctx: Context, f: (v: unknown, first: boolean) => void, input = "in") {
	const src = parse(ctx.process.args).sources.find((s) => s.input === input)
	if (src === undefined) return
	const path = inside(src.at)
	let was: unknown = undefined
	ctx.scheduler.runWithScope(ctx.scope, () =>
		ctx.scheduler.createEffect(
			() => {
				const id = get(ctx.places, path)
				return {
					id,
					v: id === undefined ? undefined : ctx.places.readValue("attributes", id, [OUT]),
				}
			},
			({ id, v }) => {
				if (id === undefined || v === undefined) return
				const first = id !== was
				was = id
				f(v, first)
			},
			(a, b) => a.id === b.id && a.v === b.v,
		))
}

const ctxOf = (api: unknown) => api as Context
const gone = (ctx: Context) => ({ stop: () => void controls.delete(String(ctx.process.id)) })

const button: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	let presses = 0
	out(presses)
	controls.set(String(ctx.process.id), { press: () => out(++presses) })
	return gone(ctx)
}

// counts the changes of its source since it started
const counter: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	let n = 0
	out(n)
	reading(ctx, (_, first) => void (first || out(++n)))
	return gone(ctx)
}

// shows its source's value; gives it on as it is
const screen: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	out(null)
	reading(ctx, (v) => out(v === undefined ? null : v))
	return gone(ctx)
}

// a line over time: each change of its source a point, one line per name (a number: one line,
// "value"). gives its lines: { name: [numbers] }, the last 40
const chart: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	const lines: Record<string, number[]> = {}
	out({})
	reading(ctx, (v) => {
		const points: Record<string, number> = typeof v === "number"
			? { value: v }
			: v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
				Object.entries(v).filter(([, x]) => typeof x === "number") as [string, number][],
			)
			: {}
		if (Object.keys(points).length === 0) return
		for (const [k, x] of Object.entries(points)) {
			const l = lines[k] ??= []
			l.push(x)
			if (l.length > 40) l.shift()
		}
		out(structuredClone(lines))
	})
	return gone(ctx)
}

// the cardputer's keyboard: gives what was typed, the last 18 letters
const keys: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	let text = ""
	out(text)
	controls.set(String(ctx.process.id), {
		type: (k) => {
			text = k === "del" ? text.slice(0, -1) : (text + k).slice(-18)
			out(text)
		},
	})
	return gone(ctx)
}

// the cardputer's pigs: gives { name: weight }; a feed puts one on. one input a pig: each change
// of what is wired into it feeds that pig. the weights start where the settings say
export const PIGS = ["babe", "peppa", "wilbur"]
const pigs: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	const { settings } = parse(ctx.process.args)
	const weights: Record<string, number> = { babe: 9, peppa: 6, wilbur: 12 }
	for (const p of PIGS) if (Number(settings[p]) > 0) weights[p] = Number(settings[p])
	out({ ...weights })
	const feed = (pig: string) => {
		weights[pig] = (weights[pig] ?? 0) + 1
		out({ ...weights })
	}
	for (const p of PIGS) {
		reading(ctx, (v, first) => {
			if (!first && v !== undefined) feed(p)
		}, p)
	}
	// what comes into "say": said, the newest; who says it goes round the pigs
	const says = writer(ctx, SAYS)
	let turn = 0
	reading(ctx, (v, first) => {
		if (first || v === undefined || v === null) return
		const text = typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v)
		says({ pig: PIGS[turn++ % PIGS.length], text: text.slice(-24), n: turn })
	}, "say")
	controls.set(String(ctx.process.id), { feed })
	return gone(ctx)
}

// a note each time what is wired in changes: the newest letter of text (a to z over a pentatonic
// scale), or a number's value round the scale. gives the note's name
const SCALE = [["c", 0], ["d", 2], ["e", 4], ["g", 7], ["a", 9]] as const
export function noteOf(v: unknown): { name: string; freq: number } | undefined {
	let i: number
	if (typeof v === "number") i = Math.abs(Math.round(v))
	else if (typeof v === "string") {
		const c = v.toLowerCase().replace(/[^a-z]/g, "").at(-1)
		if (c === undefined) return undefined
		i = c.charCodeAt(0) - 97
	} else return undefined
	const step = i % 10, [name, semis] = SCALE[step % 5], octave = 4 + Math.floor(step / 5)
	return { name: `${name}${octave}`, freq: 261.63 * 2 ** ((semis + 12 * (octave - 4)) / 12) }
}
const sound: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	out(null)
	reading(ctx, (v, first) => {
		if (first) return
		const n = noteOf(v)
		if (!n) return
		speaker.play(n.name, n.freq)
		out(n.name)
	})
	return gone(ctx)
}

// ticks up every so many seconds (1, 2 or 5); paused, it holds
const timer: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx), state = writer(ctx, STATE)
	let ticks = 0, every = 1, paused = false
	out(ticks)
	state({ every, paused })
	let id = setInterval(() => !paused && out(++ticks), every * 1000)
	controls.set(String(ctx.process.id), {
		every: (s) => {
			every = s
			clearInterval(id)
			id = setInterval(() => !paused && out(++ticks), every * 1000)
			state({ every, paused })
		},
		pause: () => {
			paused = !paused
			state({ every, paused })
		},
	})
	return {
		stop: () => {
			clearInterval(id)
			controls.delete(String(ctx.process.id))
		},
	}
}

// a pad: squares drawn with a mouse (PAD). gives its picture; a picture of the same size wired into
// its in is drawn under its own squares (your pad wired into mine: both drawings on mine). its out
// is written a little after the drawing moves, not each square: every out is a row sent
const pad: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx), state = writer(ctx, STATE)
	const mine = new Uint8Array(Math.ceil((PAD.width * PAD.height) / 8))
	// its own squares, as hex, when it was started again (a rewire): kept, as the pigs keep weights
	const kept = parse(ctx.process.args).settings.squares ?? ""
	for (let i = 0; i < mine.length && 2 * i + 2 <= kept.length; i++) {
		mine[i] = parseInt(kept.slice(2 * i, 2 * i + 2), 16) || 0
	}
	let under: Uint8Array | undefined
	let due: ReturnType<typeof setTimeout> | undefined
	// out: its squares and what is under; state: its own squares alone (what a rewire keeps)
	const give = () => {
		clearTimeout(due)
		due = undefined
		const squares = mine.slice()
		if (under) { for (let i = 0; i < squares.length; i++) squares[i] |= under[i] }
		out({ ...PAD, squares })
		state({ squares: mine.slice() })
	}
	give()
	reading(ctx, (v) => {
		under = isPicture(v) && v.width === PAD.width && v.height === PAD.height
			? v.squares
			: undefined
		give()
	})
	controls.set(String(ctx.process.id), {
		draw: (x, y, on) => {
			if (x < 0 || y < 0 || x >= PAD.width || y >= PAD.height) return
			const i = y * PAD.width + x, bit = 0x80 >> (i & 7)
			const was = mine[i >> 3]
			mine[i >> 3] = on ? was | bit : was & ~bit
			if (mine[i >> 3] !== was) due ??= setTimeout(give, 150)
		},
		clear: () => {
			mine.fill(0)
			give()
		},
		now: () => ({
			mine: { ...PAD, squares: mine },
			under: under && { ...PAD, squares: under },
		}),
	})
	return {
		stop: () => {
			clearTimeout(due)
			controls.delete(String(ctx.process.id))
		},
	}
}

export const RUNNERS = {
	button: { run: button, program: "a button: gives how many times it was pressed" },
	pad: { run: pad, program: "a pad: squares drawn with a mouse, and what is wired in under them" },
	counter: { run: counter, program: "a counter: counts the changes of what it reads" },
	screen: { run: screen, program: "a screen: shows what it reads, big" },
	chart: { run: chart, program: "a chart: a line over time of what it reads" },
	sound: { run: sound, program: "a sound: plays a note each time what it reads changes" },
	timer: { run: timer, program: "a timer: ticks up every so many seconds" },
	keys: { run: keys, program: "keys: gives what was typed" },
	pigs: { run: pigs, program: "pigs: gives each pig's weight" },
} as const
