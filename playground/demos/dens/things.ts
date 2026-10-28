// the things: one runner each, given the den's Start (process, folder, scheduler...). a thing
// writes what it gives on its own process node: its first outlet at attributes["thing.out"], any
// other at attributes["thing.<name>"] (OUTLETS). it reads its sources the same way: their nodes'
// attributes, here or mirrored from away. its args say what it reads, as triples [input, den id,
// path] (a counter's input is "in", a pig's its name; the path where the source runs: here, or as
// away places another den's process), each followed by "=<outlet>" when it reads an outlet other
// than the first, and any settings as "name=value" (the pigs' weights to start at). by path, so a
// source started again is followed
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/upsert"
import update from "@ermine/core/changeable/update"
import type { Entry } from "@ermine/core/node/entry"
import { get } from "@ermine/core/places/lib"
import { inside } from "@ermine/processes/start"
import type { Places } from "@ermine/core/places"
import type { Scheduler } from "@ermine/core/scheduler"
import type { Table } from "@ermine/core/table"
import type { Runner, Start } from "@ermine/software"
import { isVoice, type Voice } from "./sound.ts"

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// what a thing is run with: its start, and the den's scheduler, table and the den's places (the
// host gives them: withDen)
type Context = Start & {
	readonly scheduler: Scheduler
	readonly table: Table
	readonly places: Places
}
type Run = (code: unknown, ctx: Context) => ReturnType<Runner["start"]>
// a thing's run as software's runner takes it: the den's scheduler and table added to its start
export const withDen =
	(run: Run, den: { scheduler: Scheduler; table: Table; places: Places }): Runner["start"] =>
	(code, start) => run(code, { ...start, ...den })

const OUT = "thing.out"
// a timer's every and paused, beside its out
export const STATE = "thing.state"

// from: the outlet it reads, by name; none: the source's first, its out
export type Source = { input: string; den: string; at: string; from?: string }
// the attribute an outlet is written at: the first (none named) at thing.out
export const outlet = (from?: string) => from ? `thing.${from}` : OUT
// what args say: the sources, and the settings. an arg starting "=" just after a triple names the
// outlet that triple reads (a setting's name is never empty, so to a reader before outlets it is
// a setting nobody asks for, and the triples come out the same)
export function parse(
	args: readonly string[],
): { sources: Source[]; settings: Record<string, string> } {
	const sources: Source[] = [], settings: Record<string, string> = {}
	// the arg just after the last triple
	let after = -1
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		const eq = a.indexOf("=")
		if (eq === 0) {
			if (i === after && a.length > 1) sources[sources.length - 1].from = a.slice(1)
		} else if (eq !== -1) settings[a.slice(0, eq)] = a.slice(eq + 1)
		else if (i + 2 < args.length) {
			sources.push({ input: a, den: args[i + 1], at: args[i + 2] })
			i += 2
			after = i + 1
		}
	}
	return { sources, settings }
}
// args that are wires only (no settings), as their sources; else undefined
export function wires(args: readonly string[]): Source[] | undefined {
	const { sources, settings } = parse(args)
	const n = sources.reduce((n, s) => n + (s.from ? 4 : 3), 0)
	return sources.length && n === args.length && Object.keys(settings).length === 0 &&
			sources.every((s) => s.at.startsWith("/"))
		? sources
		: undefined
}
export function unparse(sources: readonly Source[], settings: Record<string, string> = {}) {
	return [
		...sources.flatMap((s) => [s.input, s.den, s.at, ...(s.from ? [`=${s.from}`] : [])]),
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
	// a sound's or a speaker's voice
	choose?: (name: Voice) => void
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
// what a sound thing and a speaker play through: the page's (its mute, its waiting for a click),
// set by the page. silent: a den whose speaker isn't driven (the cardputer's, for now)
export const voice = {
	play: (_name: Voice): "played" | "muted" | "waiting" | "silent" => "silent",
	silent: false,
}
// what the pigs were told to say: their second outlet
export const SAYS = outlet("says")

// its out (or another attribute of its node), written with its scope open
function writer(ctx: Context, name = OUT) {
	const s = ctx.scheduler
	return (v: unknown) =>
		s.runWithScope(ctx.scope, () =>
			ctx.places.commit(
				upsert(ctx.table, "attributes", ctx.process.id, [name], v, createChangeHeader(s)),
			))
}

// patches to its out (or another attribute of its node), written with its scope open: a splice
// costs what it adds, not the whole value
function patcher(ctx: Context, name = OUT) {
	const s = ctx.scheduler
	return (...ps: { range: [number, number]; value?: string }[]) =>
		s.runWithScope(ctx.scope, () => {
			const there = ctx.table.get("attributes", ctx.process.id) as Entry<unknown> | undefined
			if (there === undefined) return
			update(there, ps.map((p) => ({ path: [name], ...p })), createChangeHeader(s))
			ctx.places.commit([there])
		})
}

// the outlet wired into input, tracked (the path, then the node there): f told each value;
// first: the first, or the first from a node now at that path (a source started again)
function reading(ctx: Context, f: (v: unknown, first: boolean) => void, input = "in") {
	const src = parse(ctx.args).sources.find((s) => s.input === input)
	if (src === undefined) return
	const path = inside(src.at), name = outlet(src.from)
	let was: unknown = undefined
	ctx.scheduler.runWithScope(ctx.scope, () =>
		ctx.scheduler.createEffect(
			() => {
				const id = get(ctx.places, path)
				return {
					id,
					v: id === undefined ? undefined : ctx.places.readValue("attributes", id, [name]),
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

// the cardputer's keyboard. text: what it holds, the last 280 letters. typed: each key as it is
// pressed, { key, n }: a letter, " ", or "del", and how many keys so far (two a's in a row are two
// values, n tells them apart); null until the first
export const LONGEST = 280
const keys: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx), splice = patcher(ctx), typed = writer(ctx, outlet("typed"))
	// what it holds, as letters (code points: a splice's range counts them)
	const text: string[] = []
	let n = 0
	out("")
	typed(null)
	controls.set(String(ctx.process.id), {
		type: (k) => {
			if (k === "del") {
				if (text.length) splice({ range: [text.length - 1, text.length] }), text.pop()
			} else {
				const add = [...k]
				const over = Math.max(0, text.length + add.length - LONGEST)
				const ps: { range: [number, number]; value?: string }[] = []
				if (over) ps.push({ range: [0, over] }), text.splice(0, over)
				ps.push({ range: [text.length, text.length], value: k })
				text.push(...add)
				splice(...ps)
			}
			typed({ key: k, n: ++n })
		},
	})
	return gone(ctx)
}

// the cardputer's pigs: gives { name: weight }; a feed puts one on. one input a pig: each change
// of what is wired into it feeds that pig. the weights start where the settings say. says: what
// came into "say", { pig, text, n }
export const PIGS = ["babe", "peppa", "wilbur"]
const pigs: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx)
	const { settings } = parse(ctx.args)
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

// a sound: one of the voices (sound.ts), chosen on its box; its big button plays it here, and so
// does each change of what is wired into its in. gives { sound, n }: the voice, the nth time
const sound: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx), state = writer(ctx, STATE)
	const kept = parse(ctx.args).settings.sound
	let chosen: Voice = isVoice(kept) ? kept : "ding", n = 0
	out(null)
	state({ sound: chosen })
	const play = () => {
		voice.play(chosen)
		out({ sound: chosen, n: ++n })
	}
	reading(ctx, (_, first) => void (first || play()))
	controls.set(String(ctx.process.id), {
		press: play,
		choose: (name) => (chosen = name, state({ sound: chosen })),
	})
	return gone(ctx)
}

// a den's speaker, on its card: each change of what is wired in played on this den's machine: the
// voice a sound thing sent, else the one chosen on the card (a blip to start). gives { sound, n,
// heard }: what it played, the nth time, and whether it was heard ("played", "muted", "waiting"
// for a click, "silent": not driven here)
const speaker: Run = (_, api) => {
	const ctx = ctxOf(api)
	const out = writer(ctx), state = writer(ctx, STATE)
	const kept = parse(ctx.args).settings.sound
	let chosen: Voice = isVoice(kept) ? kept : "blip", n = 0
	out(null)
	state({ sound: chosen })
	reading(ctx, (v, first) => {
		if (first) return
		const name = isMap(v) && isVoice(v.sound) ? v.sound : chosen
		const heard = voice.silent ? "silent" : voice.play(name)
		out({ sound: name, n: ++n, heard })
	})
	controls.set(String(ctx.process.id), {
		choose: (name) => (chosen = name, state({ sound: chosen })),
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
	const kept = parse(ctx.args).settings.squares ?? ""
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

// a thing's kind from its node's attributes: a part's "thing.kind" (the cardputer's, a plain
// process), else its runner's last step (software's); none: not a thing
export function kindOf(attrs: unknown): string | undefined {
	if (!isMap(attrs)) return undefined
	if (typeof attrs["thing.kind"] === "string") return attrs["thing.kind"]
	const r = attrs["ermine.process.runner"]
	return isMap(r) && Array.isArray(r.at) && r.at.length ? String(r.at.at(-1)) : undefined
}
// how it is: "running", "starting" (its status pending), or "failed: <words>"
export function stateOf(attrs: unknown): string {
	const st = isMap(attrs) ? attrs["ermine.computer.status"] : undefined
	if (st === "pending" || typeof st === "symbol") return "starting"
	if (st instanceof Error) return `failed: ${st.message}`
	if (isMap(st) && typeof st.failed === "string") return `failed: ${st.failed}`
	return "running"
}

// what each kind gives: its outlets, by name, each with a few words; the first is its out
// (thing.out), whatever it is called. none listed: one, "out"
export const OUTLETS: Record<string, [string, string][]> = {
	keys: [
		["text", "what it holds, the last 280 letters"],
		["typed", 'each key as it is pressed: { key, n }, del as "del"'],
	],
	pigs: [
		["weights", "each pig's weight"],
		["says", "what the pigs were told to say: { pig, text, n }"],
	],
	speaker: [],
}
export const outletsOf = (kind: string): [string, string][] =>
	OUTLETS[kind] ?? [["out", "what it gives"]]

export const RUNNERS = {
	button: { run: button, program: "a button: gives how many times it was pressed" },
	pad: { run: pad, program: "a pad: squares drawn with a mouse, and what is wired in under them" },
	counter: { run: counter, program: "a counter: counts the changes of what it reads" },
	screen: { run: screen, program: "a screen: shows what it reads, big" },
	chart: { run: chart, program: "a chart: a line over time of what it reads" },
	sound: { run: sound, program: "a sound: a voice to play, by its button or what it reads" },
	speaker: {
		run: speaker,
		program: "a speaker: on a den's card, it plays each change of what is wired into it",
	},
	timer: { run: timer, program: "a timer: ticks up every so many seconds" },
	keys: { run: keys, program: "keys: gives what was typed" },
	pigs: { run: pigs, program: "pigs: gives each pig's weight" },
} as const
