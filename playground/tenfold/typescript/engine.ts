// engine: tenfold's engine as a program (ermine/api's form, its default given the api), started on
// a den's javascript runner. one process holding one surface; the letters are not processes, they
// are draws run on the runner it offers:
//
//   den.start("/system/den/runners/javascript", "/tenfold/engine.js", "/tenfold/view",
//     { args: [surface, knobs, letters] })     // none: SURFACE, KNOBS, LETTERS
//
// what it makes, under its node (/tenfold/view):
//   runners/letter   offered: takes ermine.tenfold-letter (source through the loop budget), api
//                    ermine.tenfold.letter (letter.ts' pen and params). its value loads a letter;
//                    started as a process with args [cell], the letter is that cell's guest
//   clock            { ms }: written each frame of the surface's
//   cells/<i>        a memo a cell (as many as the knobs say at start): the knob read, the letter
//                    at <letters>/<knob.letter> read, compiled (the den's loop-budget, cached by
//                    build) and loaded on runners/letter (again only when its code is new), drawn on
//                    the surface. its value { letter, cost } (cost: the draw's ms); a throw, its
//                    status (and its run's error, ermine/api's runs): the cell marked error with
//                    what was thrown. a draw over knobs.slow ms (none: 6) marked cost. a guest
//                    draws instead of the knob's letter, from the next frame, while it runs
// the knobs: { cells: [{ letter, q?, r?, x?, y? }], period? (ms; none: 6000), slow? }
// stopped: the den stops its guests ("runner-stopped") and withdraws runners/letter; its memos go
// with its scope, and the frames with them
import type { API } from "@ermine/api"
import type { Handle, Runner } from "@ermine/dens"
import { API as GIVES_API, TAKES, WHERE } from "@ermine/dens"
import { createPen, load, type Loaded, type Op } from "./letter.ts"
import type { Surface } from "./surfaces.ts"

export const LETTER = "ermine.tenfold-letter"
export const LETTER_API = "ermine.tenfold.letter"
export const SURFACE = "/system/den/surfaces/screen"
export const KNOBS = "/tenfold/knobs"
export const LETTERS = "/tenfold/letters"
export const BUDGET = "/system/den/compilers/loop-budget"

export type Knob = {
	readonly letter: string
	readonly q?: number
	readonly r?: number
	readonly x?: number
	readonly y?: number
}
export type Knobs = {
	readonly cells: readonly Knob[]
	readonly period?: number
	readonly slow?: number
}

// the api the engine is written against: ermine/api's, and what this den's host adds (tenfold.ts):
// an offer under the process's node, and build's compile with a compiler at an address
export type EngineAPI = API & {
	offer: (
		kind: "runners",
		name: string,
		attributes: Record<string, unknown>,
		live: unknown,
	) => unknown
	compile: (compiler: string, input: unknown) => unknown
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e)

export default function engine(api: EngineAPI): string {
	const [surfaceAt = SURFACE, knobsAt = KNOBS, lettersAt = LETTERS] = api.args
	const surface = api.peep(surfaceAt) as Surface
	if (typeof surface?.draw !== "function") throw new Error(`no surface at ${surfaceAt}`)
	const clock = api.open("clock", { ms: 0 })
	// by cell: a guest letter (a process on runners/letter), drawn instead of the knob's
	const guests = new Map<number, Loaded>()
	// by letter: its s, kept across frames
	const states = new Map<string, Record<string, unknown>>()

	const letter: Runner = (code, given) => {
		const loaded = load(String(code))
		const cell = Number((given as { args?: readonly string[] } | undefined)?.args?.[0])
		if (!Number.isInteger(cell)) return loaded
		guests.set(cell, loaded)
		const handle: Handle & Loaded = {
			draw: loaded.draw,
			stop: () => void (guests.get(cell) === loaded && guests.delete(cell)),
		}
		return handle
	}
	api.offer(
		"runners",
		"letter",
		{ [TAKES]: LETTER, [GIVES_API]: LETTER_API, [WHERE]: "den" },
		letter,
	)

	const stopFrames = surface.frames((ms) => api.edit(clock, [{ path: [], value: { ms } }]))
	api.teardown(() => stopFrames())

	const count = (api.peep(knobsAt, ["cells"]) as Knob[] | undefined)?.length ?? 0
	api.open("cells", { count })
	for (let i = 0; i < count; i++) cell(i)

	function cell(i: number) {
		const emit = (op: Op) => surface.draw(i, op)
		const pen = createPen(emit)
		// the letter shown: its code, and it loaded (or why it would not)
		let shown: { code: string; loaded: Loaded } | { code: string; error: unknown } | undefined
		api.teardown(() => shown && "loaded" in shown && shown.loaded.stop())

		const fail = (e: unknown): never => {
			emit(["mark", "error", message(e)])
			throw e
		}

		// code loaded on runners/letter, again only when it is new
		function loaded(code: string): Loaded {
			if (shown?.code !== code) {
				if (shown && "loaded" in shown) shown.loaded.stop()
				const run = api.read("runners/letter") as Runner
				try {
					shown = { code, loaded: run(code, undefined) as Loaded }
				} catch (error) {
					shown = { code, error }
				}
			}
			const now = shown!
			if ("error" in now) throw now.error
			return now.loaded
		}

		// the cell's letter: a guest, or the knob's, compiled and loaded
		function letterOf(knob: Knob): { name: string; loaded: Loaded } | typeof api.PENDING {
			const guest = guests.get(i)
			if (guest !== undefined) return { name: `guest/${i}`, loaded: guest }
			const source = api.read(`${lettersAt}/${knob.letter}`)
			if (typeof source !== "string") throw new Error(`no letter at ${knob.letter}`)
			const code = api.compile(BUDGET, source)
			if (code === api.PENDING) return api.PENDING
			if (typeof code !== "string") throw code instanceof Error ? code : new Error("no code")
			return { name: knob.letter, loaded: loaded(code) }
		}

		api.memo(`cells/${i}`, () => {
			const { ms } = api.read(clock) as { ms: number }
			const knobs = api.read(knobsAt) as Knobs
			const knob = knobs.cells[i] ?? { letter: "" }
			let got
			try {
				got = letterOf(knob)
			} catch (e) {
				surface.clear(i)
				return fail(e)
			}
			if (got === api.PENDING) return api.PENDING
			surface.clear(i)
			const { name } = got
			let s = states.get(name)
			if (s === undefined) states.set(name, s = {})
			const period = knobs.period ?? 6000
			const params = {
				q: knob.q ?? 0,
				r: knob.r ?? 0,
				x: knob.x ?? 0,
				y: knob.y ?? 0,
				t: (ms % period) / period,
				s,
			}
			const started = performance.now()
			try {
				pen.begin()
				got.loaded.draw(pen.pen, params)
				pen.end()
			} catch (e) {
				fail(e)
			}
			const cost = performance.now() - started
			if (cost > (knobs.slow ?? 6)) emit(["mark", "cost", `${cost.toFixed(1)} ms`])
			return { letter: name, cost }
		})
	}
	return "tenfold"
}
