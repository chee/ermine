/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	hasNode,
	list,
	patch,
	peep,
	place,
	read,
	ref,
	rename,
	unplace,
} from "@ermine/system"
import { up } from "@ermine/slaygrounds/tools"
import { bind, handler, under } from "ermine-h"

// fancy-sequencer: a song of four bars, each holding a pattern; a pattern holds a folder per step
// (s0…s15), and a note is a node in its step's folder:
//   /song/bar2/s5/n3fa1 = {pitch: 64, len: 1, vel: 0.8}     (or {drum: "kick"})
// so a note's step is where it is placed (dragging it sideways is places' move), and its pitch is
// its value. a pattern can be in two bars at once: ⧉ mounts the same node in the next bar, so an
// edit in one is the edit in both. ✂ gives a bar its own copy.
// three processes, at /run/<name> (so /clock, /song, /player are saved folders of their own, named
// from the root: ./ is /run): the clock is the playhead (it writes /clock/next ahead of time, on
// the audio clock, and /clock/at when the step is heard); the roll is the editor; the player reads
// the notes at each step, through the bar's route, and plays them. its "explain" panel says what
// it read, and by which route. nothing is open after a timer, so the clock's loop is not one: it
// is an element in the clock's view whose css animation cycles every 20ms (while playing), and
// each cycle's animationiteration calls on/beat through a handler
const BARS = ["bar1", "bar2", "bar3", "bar4"]
const STEPS = Array.from({ length: 16 }, (_, i) => i)
const TOP = 72 // C5: the roll's first row; 25 notes down to C3, then the two drums
const ROWS: (number | string)[] = [...Array.from({ length: 25 }, (_, i) => TOP - i), "hat", "kick"]
const CELL = 33, ROW = 12
const LOOKAHEAD = 0.12
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
const INKS = ["#ff2284", "#2269ff", "#40dcba", "#ffcc00", "#000000"]
// deno-lint-ignore no-explicit-any
type Any = any
type Note = { pitch?: number; drum?: string; len?: number; vel?: number }
type Next = { n: number; bar: string; step: number; at: number; dur: number }

const noteName = (v: Note) =>
	v.drum ?? `${NAMES[(v.pitch ?? 0) % 12]}${Math.floor((v.pitch ?? 0) / 12) - 1}`
const rowOf = (v: Note) => ROWS.indexOf(v.drum ?? (v.pitch as number))
const valueFor = (row: number, old?: Note): Note => {
	const r = ROWS[row]
	return typeof r === "string"
		? { drum: r, vel: old?.vel ?? (r === "kick" ? 1 : 0.5) }
		: { pitch: r, len: old?.len ?? 1, vel: old?.vel ?? 0.8 }
}
const pct = (v: number) => Math.round(v * 100) + "%"
// a name's children, none when there is no such folder (a step nobody has put a note in)
const kids = (p: string) => (hasNode(p) ? list(p) : [])
// a node's value now, from an action (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0]) => peep(() => read(x)) as T
const put = (x: Parameters<typeof read>[0], v: unknown) => patch(x, [{ path: [], value: v }])
// the id of the node at a path (names from the root), told by up, tracked
const idOf = (p: string) => up(p.split("/").filter(Boolean), [])?.found

// ---- the clock: the playhead. tempo and swing are nodes ----
export function clock() {
	const tempo = ensureNode("/clock/tempo", 104)
	const swing = ensureNode("/clock/swing", 0.18)
	const playing = ensureNode("/clock/playing", false)
	// next: the step about to be heard, written LOOKAHEAD early, with its time on the audio clock.
	// at: the step being heard now (written when it is heard, for eyes)
	const next = ensureNode("/clock/next", null)
	const at = ensureNode("/clock/at", { bar: "bar1", step: 0 })
	// the playhead's count and base time: kept across reloads, it is a live thing
	const state = peep(() => read(ref("/clock/state", () => ({ n: 0, base: 0 })))) as {
		n: number
		base: number
	}

	createAction("on/play", () => {
		// the audio context is made inside the click: audio needs a person's gesture
		const ctx = peep(() =>
			read(ref("/audio", () => new AudioContext({ latencyHint: "interactive" })))
		)
		const now = !get(playing)
		if (now) {
			;(ctx as AudioContext).resume()
			Object.assign(state, { n: 0, base: (ctx as AudioContext).currentTime + 0.08 })
			due.length = 0
		}
		put(playing, now)
	})
	createAction("on/tempo", (v: number) => put(tempo, Math.round(v)))
	createAction("on/swing", (v: number) => put(swing, Number(v.toFixed(2))))

	// the loop, every 20ms (on/beat): write the steps due in the next LOOKAHEAD seconds. an odd step
	// is late by the swing. a step is "heard" when its time comes: due holds each, and a beat writes
	// /clock/at for the ones whose time has passed (no timer writes it). it reads what is there now
	const due: { when: number; bar: string; step: number }[] = []
	createAction("on/beat", () => {
		const ctx = hasNode("/audio") ? get<AudioContext>("/audio") : undefined
		if (get(playing) !== true || !(ctx instanceof AudioContext) || ctx.state !== "running") {
			return
		}
		const bpm = Number(get(tempo)) || 104
		const late = Math.min(0.7, Math.max(0, Number(get(swing)) || 0))
		const d = 60 / bpm / 4
		if (state.base < ctx.currentTime - 0.2) state.base = ctx.currentTime + 0.05
		while (state.base < ctx.currentTime + LOOKAHEAD) {
			const n = state.n++
			const step = n % 16, bar = BARS[Math.floor(n / 16) % BARS.length]
			const when = state.base + (n % 2 ? late * d : 0)
			put(next, { n, bar, step, at: when, dur: d })
			due.push({ when, bar, step })
			state.base += d
		}
		let heard: (typeof due)[number] | undefined
		while (due.length && due[0].when <= ctx.currentTime) heard = due.shift()
		if (heard) put(at, { bar: heard.bar, step: heard.step })
	})

	return (
		<div class="transport card">
			<style>{LOOK}</style>
			<span class="tag">fancy sequencer</span>
			<button
				class="play"
				data-on={bind("clock/playing", (p) => (p ? "on" : undefined))}
				onClick={handler("on/play")}
			>
				{bind("clock/playing", (p) => (p ? "■ stop" : "▶ play"))}
			</button>
			<label>
				tempo
				<input
					type="range"
					min="60"
					max="180"
					value={bind("clock/tempo")}
					onInput={handler("on/tempo", (e: Event) => [+(e.target as HTMLInputElement).value])}
				/>
				<b>{bind("clock/tempo")}</b>
			</label>
			<label>
				swing
				<input
					type="range"
					min="0"
					max="0.6"
					step="0.01"
					value={bind("clock/swing")}
					onInput={handler("on/swing", (e: Event) => [+(e.target as HTMLInputElement).value])}
				/>
				<b>{bind("clock/swing", pct)}</b>
			</label>
			<span class="pos" title="/clock/at: the step being heard">
				{bind("clock/at", (a) => `${a.bar} · ${String(a.step + 1).padStart(2, "0")}/16`)}
			</span>
			<i
				class="beat"
				style={bind("clock/playing", (p) => `animation-play-state:${p ? "running" : "paused"}`)}
				onAnimationIteration={handler("on/beat")}
			/>
		</div>
	)
}

// ---- the roll: the song (four bars) and the piano roll of the bar being edited ----
const SEED: Record<string, [number, Note][]> = {
	// A minor, climbing and falling
	A: [
		[0, { pitch: 57, len: 2, vel: 0.9 }],
		[2, { pitch: 64 }],
		[3, { pitch: 69 }],
		[4, { pitch: 72 }],
		[6, { pitch: 71 }],
		[7, { pitch: 69 }],
		[8, { pitch: 64, len: 2 }],
		[10, { pitch: 67 }],
		[11, { pitch: 69 }],
		[12, { pitch: 64 }],
		[14, { pitch: 60 }],
		[15, { pitch: 62 }],
	],
	// F, then G, back home
	B: [
		[0, { pitch: 53, len: 2, vel: 0.9 }],
		[2, { pitch: 60 }],
		[3, { pitch: 65 }],
		[4, { pitch: 69 }],
		[6, { pitch: 67 }],
		[7, { pitch: 65 }],
		[8, { pitch: 55, len: 2 }],
		[10, { pitch: 62 }],
		[11, { pitch: 67 }],
		[12, { pitch: 71 }],
		[14, { pitch: 62 }],
		[15, { pitch: 64 }],
	],
}
const BEAT: [number, Note][] = [
	...[0, 4, 8, 12].map((s): [number, Note] => [s, { drum: "kick", vel: 1 }]),
	...[2, 6, 10, 14].map((s): [number, Note] => [s, { drum: "hat", vel: 0.55 }]),
	...[7, 15].map((s): [number, Note] => [s, { drum: "hat", vel: 0.25 }]),
]

export function roll() {
	const id = () => "n" + crypto.randomUUID().slice(0, 5)
	// the first time only: A in bar 1, mounted in bar 2; B in bar 3, mounted in bar 4
	if (kids("/song").length === 0) {
		for (const [name, bar, again] of [["A", "bar1", "bar2"], ["B", "bar3", "bar4"]]) {
			const p = `/song/${bar}`
			ensureNode(p, { name, ink: INKS[name === "A" ? 0 : 1] })
			for (const [step, note] of [...SEED[name], ...BEAT]) {
				ensureNode(`${p}/s${step}/${id()}`, { len: 1, vel: 0.8, ...note })
			}
			place(`/song/${again}`, p)
		}
	}
	const bar = ensureNode("/roll/bar", "bar1")
	const pattern = (b: string) => `/song/${b}`
	const nameOf = (b: string) => (hasNode(pattern(b)) ? get<Any>(pattern(b))?.name : undefined)
	const fresh_name = () => "ABCDEFGHIJ".split("").find((c) => !BARS.map(nameOf).includes(c))!
	const notesOf = (p: string) =>
		STEPS.flatMap((k) =>
			kids(`${p}/s${k}`).map((n) => ({ k, ...(read(`${p}/s${k}/${n}`) as Note) }))
		)

	// which bars hold the same pattern node: "bar2 = bar1"
	createMemo("shares", () => {
		const ids = BARS.map((b) => idOf(pattern(b)))
		return Object.fromEntries(
			BARS.map((b, i) => [b, BARS.filter((o, j) => j !== i && ids[j] && ids[j] === ids[i])]),
		)
	})
	// the playhead, when the bar being heard is the pattern on the roll (the same node)
	createMemo("playhead", () => {
		const a = read("/clock/at") as Any
		const heard = a && idOf(pattern(a.bar)), shown = idOf(pattern(read(bar) as string))
		return { step: a?.step ?? 0, here: !!heard && heard === shown }
	})

	createAction("on/select", (b: string) => put(bar, b))
	// a note drawn: in the step's folder (made the first time), unless that row has one
	createAction("on/draw", (step: number, row: number) => {
		const p = pattern(get<string>(bar))
		if (!hasNode(p)) return
		const folder = `${p}/s${step}`
		const there = peep(() => kids(folder)).some((n) => rowOf(get<Note>(`${folder}/${n}`)) === row)
		if (!there) ensureNode(`${folder}/${id()}`, valueFor(row))
	})
	// a note let go of, moved by (steps, rows): not moved, it is taken out; moved, it goes there
	// (its step by a rename, its row by its value)
	createAction("on/drop", (name: string, from: number, steps: number, rows: number) => {
		const p = pattern(get<string>(bar))
		if (!hasNode(`${p}/s${from}/${name}`)) return
		const v = get<Note>(`${p}/s${from}/${name}`)
		if (!steps && !rows) return unplace(`${p}/s${from}/${name}`)
		const to = Math.min(15, Math.max(0, from + steps))
		const row = Math.min(ROWS.length - 1, Math.max(0, rowOf(v) + rows))
		if (from !== to) {
			ensureNode(`${p}/s${to}`, null)
			rename(`${p}/s${from}/${name}`, `${p}/s${to}/${name}`)
		}
		if (rowOf(v) !== row) put(`${p}/s${to}/${name}`, valueFor(row, v))
	})
	// ⧉: this bar's pattern mounted in the next bar too (what was there is unplaced, not deleted)
	createAction("on/mount", (b: string) => {
		const into = BARS[(BARS.indexOf(b) + 1) % BARS.length]
		const here = peep(() => idOf(pattern(b)))
		if (here === undefined || peep(() => idOf(pattern(into))) === here) return
		unplace(pattern(into))
		place(pattern(into), pattern(b))
	})
	// ✂: this bar gets a pattern of its own, a copy (new nodes, new name)
	createAction("on/unlink", (b: string) => {
		if (!hasNode(pattern(b))) return
		const name = fresh_name()
		const notes = peep(() => notesOf(pattern(b)))
		unplace(pattern(b))
		ensureNode(pattern(b), { name, ink: INKS["ABCDEFGHIJ".indexOf(name) % INKS.length] })
		for (const { k, ...note } of notes) ensureNode(`${pattern(b)}/s${k}/${id()}`, note)
	})
	// ∅: an empty pattern of its own
	createAction("on/empty", (b: string) => {
		const name = fresh_name()
		if (hasNode(pattern(b))) unplace(pattern(b))
		ensureNode(pattern(b), { name, ink: INKS["ABCDEFGHIJ".indexOf(name) % INKS.length] })
	})

	// a mini roll per bar, drawn from its pattern's notes
	const minis = BARS.map((b) => {
		const c = peep(() =>
			read(
				ref(
					`/roll/mini-${b}`,
					() => Object.assign(document.createElement("canvas"), { width: 256, height: 72 }),
				),
			)
		) as HTMLCanvasElement
		c.className = "mini"
		createEffect(
			`mini-${b}`,
			() =>
				idOf(pattern(b)) === undefined
					? undefined
					: { ink: (read(pattern(b)) as Any)?.ink, notes: notesOf(pattern(b)) },
			(v) => drawMini(c, v),
		)
		return c
	})

	// ---- the pointer: drawing on the grid, dragging a note ----
	let grid: HTMLElement
	let painting: { step: number; row: number } | undefined
	let drag: { x: number; y: number; el: HTMLElement } | undefined
	const cell = (e: PointerEvent) => {
		const r = grid.getBoundingClientRect()
		const step = Math.min(15, Math.max(0, Math.floor((e.clientX - r.left) / CELL)))
		const row = Math.min(ROWS.length - 1, Math.max(0, Math.floor((e.clientY - r.top) / ROW)))
		return { step, row }
	}
	const NoteView = ({ n, k }: { n: Any; k: number }) => (
		<div
			class="note"
			data-kind={bind(n, (v: Note) => v.drum ?? "pitch")}
			style={bind(n, (v: Note) => ({
				top: rowOf(v) * ROW + "px",
				width: (v.drum ? 1 : v.len ?? 1) * CELL - 3 + "px",
				opacity: String(0.45 + 0.55 * (v.vel ?? 0.8)),
			}))}
			data-read={bind("/player/heard", (h) => (h.ids.includes(n.id) ? "yes" : undefined))}
			title={`/${(n.path ?? []).join("/")}: drag to move, click to take out`}
			onPointerDown={(e: PointerEvent) => {
				e.stopPropagation()
				const el = e.currentTarget as HTMLElement
				el.setPointerCapture(e.pointerId)
				drag = { x: e.clientX, y: e.clientY, el }
			}}
			onPointerMove={(e: PointerEvent) => {
				if (!drag) return
				drag.el.style.translate = `${e.clientX - drag.x}px ${e.clientY - drag.y}px`
			}}
			onPointerUp={handler("on/drop", (e: PointerEvent) => {
				if (!drag) return
				const d = drag
				drag = undefined
				d.el.style.translate = ""
				return [
					n.name,
					k,
					Math.round((e.clientX - d.x) / CELL),
					Math.round((e.clientY - d.y) / ROW),
				]
			})}
		>
			{bind(n, noteName)}
		</div>
	)

	return (
		<div class="roller">
			<div class="song">
				{BARS.map((b, i) => (
					<div
						class="bar card"
						data-selected={bind("roll/bar", (s) => (s === b ? "yes" : undefined))}
						data-playing={bind("/clock/at", (a) => (a.bar === b ? "yes" : undefined))}
						onClick={handler("on/select", [b])}
					>
						<header>
							<b class="tag" style={bind(`/song/${b}`, (p) => ({ background: p.ink }))}>
								{bind(`/song/${b}`, (p) => p.name)}
							</b>
							<small>bar {i + 1}</small>
							<small class="shared">
								{bind("shares", (s) => (s[b].length ? `= ${s[b].join(", ")}` : "its own"))}
							</small>
						</header>
						{minis[i]}
						<div class="acts">
							<button
								title={`the same notes in ${
									BARS[(i + 1) % 4]
								} too (a mount: one node, two places)`}
								onClick={handler("on/mount", [b])}
							>
								⧉ → {BARS[(i + 1) % 4]}
							</button>
							<button
								title="a copy of the notes, for this bar alone"
								disabled={bind("shares", (s) => s[b].length === 0)}
								onClick={handler("on/unlink", [b])}
							>
								✂
							</button>
							<button title="an empty pattern" onClick={handler("on/empty", [b])}>∅</button>
						</div>
					</div>
				))}
			</div>
			<div class="roll card">
				<header>
					<span class="tag">roll</span>
					<small>
						{bind("roll/bar", (b) => `editing ${b}`)}{" "}
						· draw on the grid · drag a note · click one to take it out
					</small>
				</header>
				<div class="sheet">
					<div class="keys">
						{ROWS.map((r) => (
							<div
								class={`key ${
									typeof r === "string"
										? "drum"
										: [1, 3, 6, 8, 10].includes(r % 12)
										? "black"
										: ""
								}`}
							>
								{typeof r === "string" ? r : r % 12 === 0 ? noteName({ pitch: r }) : ""}
							</div>
						))}
					</div>
					<div
						class="grid"
						ref={(el: HTMLElement) => void (grid = el)}
						style={{ width: 16 * CELL + "px", height: ROWS.length * ROW + "px" }}
					>
						{/* the paper under the notes takes the drawing: a note on it takes its own drag */}
						<div
							class="paper"
							aria-label="the roll"
							onPointerDown={handler("on/draw", (e: PointerEvent) => {
								;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
								painting = cell(e)
								return [painting.step, painting.row]
							})}
							onPointerMove={handler("on/draw", (e: PointerEvent) => {
								if (!painting) return
								const c = cell(e)
								if (c.step === painting.step) return
								painting = c
								return [c.step, c.row]
							})}
							onPointerUp={() => {
								painting = undefined
							}}
						/>
						<div
							class="playhead"
							style={bind("playhead", (h) => ({
								left: h.step * CELL + "px",
								opacity: h.here ? "1" : "0.25",
							}))}
						/>
						{bind("roll/bar", (b) =>
							STEPS.map((k) => (
								<div class="col" style={{ left: k * CELL + "px" }}>
									{under(`/song/${b}/s${k}`, (n) => <NoteView n={n} k={k} />)}
								</div>
							)))}
					</div>
				</div>
			</div>
		</div>
	)
}

function drawMini(c: HTMLCanvasElement, v?: { ink: string; notes: (Note & { k: number })[] }) {
	const g = c.getContext("2d")!
	const W = c.width, H = c.height
	g.fillStyle = "#fff"
	g.fillRect(0, 0, W, H)
	g.fillStyle = "#ffd9ea"
	for (let k = 0; k < 16; k += 4) g.fillRect((k * W) / 16, 0, 1, H)
	if (!v) return
	for (const n of v.notes) {
		const row = rowOf(n)
		if (row < 0) continue
		const y = (row / ROWS.length) * H
		g.fillStyle = n.drum ? "#000" : v.ink
		g.fillRect(
			(n.k * W) / 16 + 1,
			y,
			((n.drum ? 1 : n.len ?? 1) * W) / 16 - 2,
			H / ROWS.length + 1,
		)
	}
}

// ---- the player: at each step, the notes there, read through the bar's route; then sound ----
export function player() {
	const tone = ensureNode("/player/tone", 0.55)
	const echo = ensureNode("/player/echo", 0.32)
	const trace = ensureNode("/player/trace", [])
	createAction("on/tone", (v: number) => put(tone, v))
	createAction("on/echo", (v: number) => put(echo, v))

	// heard: what this step reads, and how. the bar's pattern, its step folder, each note in it;
	// a note's route is the way it was reached (/song/bar2/… for a mount of bar1's pattern).
	// also which bars hold the same pattern node
	const heard = createMemo("/player/heard", () => {
		const next = read("/clock/next") as Next | null | undefined
		if (!next) return { n: -1, ids: [], notes: [] }
		const p = `/song/${next.bar}`, pid = idOf(p)
		const folder = `${p}/s${next.step}`
		const notes = (pid === undefined ? [] : kids(folder))
			.map((n) => ({
				id: idOf(`${folder}/${n}`),
				route: `${folder}/${n}`,
				...(read(`${folder}/${n}`) as Note),
			}))
		const same = pid === undefined
			? []
			: BARS.filter((b) => b !== next.bar && idOf(`/song/${b}`) === pid)
		return {
			...next,
			folder,
			pattern: pid === undefined ? undefined : (read(p) as Any)?.name,
			same,
			notes,
			ids: notes.map((n) => n.id),
		}
	})

	// the sound: a chain made once per audio context (kept on reload, so it keeps ringing)
	const live = peep(() =>
		read(ref("/player/live", () => ({ chain: undefined as Any, last: -1 })))
	) as {
		chain: Any
		last: number
	}
	createEffect("player-chain", () => read("/audio"), (ctx) => {
		if (!(ctx instanceof AudioContext) || live.chain?.ctx === ctx) return
		live.chain = chain(ctx)
	})
	createEffect(
		"player-knobs",
		() => [read(tone), read(echo), read("/clock/tempo")] as const,
		([tn, ec, bpm]) => {
			const c = live.chain
			if (!c) return
			c.tone = Number(tn)
			c.send.gain.setTargetAtTime(Number(ec), c.ctx.currentTime, 0.05)
			// a dotted eighth
			c.echo.delayTime.setTargetAtTime(
				(60 / (Number(bpm) || 104)) * 0.75,
				c.ctx.currentTime,
				0.1,
			)
		},
	)
	// each new step once: the notes scheduled at its time, and a line in the trace
	createEffect("player-plays", () => read(heard) as Any, (h) => {
		if (!h || h.n < 0 || h.n === live.last) return
		live.last = h.n
		const c = live.chain
		if (c) {
			for (const n of h.notes) {
				if (n.drum === "kick") kick(c, h.at, n.vel ?? 1)
				else if (n.drum === "hat") hat(c, h.at, n.vel ?? 0.5)
				else if (typeof n.pitch === "number") {
					pluck(c, h.at, n.pitch, (n.len ?? 1) * h.dur, n.vel ?? 0.8)
				}
			}
		}
		const line = {
			n: h.n,
			bar: h.bar,
			step: h.step,
			folder: h.folder,
			pattern: h.pattern,
			same: h.same,
			notes: h.notes.map((n: Any) => ({ route: n.route, name: noteName(n) })),
		}
		put(trace, [...get<Any[]>(trace), line].slice(-8))
	})

	return (
		<div class="trace card">
			<header>
				<span class="tag">explain</span>
				<small>
					each step: the folder the player read, every note in it and the route it came by. a
					note lit on the roll is one being read
				</small>
				<label>
					tone
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						value={bind("player/tone")}
						onInput={handler(
							"on/tone",
							(e: Event) => [+(e.target as HTMLInputElement).value],
						)}
					/>
				</label>
				<label>
					echo
					<input
						type="range"
						min="0"
						max="0.8"
						step="0.01"
						value={bind("player/echo")}
						onInput={handler(
							"on/echo",
							(e: Event) => [+(e.target as HTMLInputElement).value],
						)}
					/>
				</label>
			</header>
			<ol>
				{bind("player/trace", (lines: Any[]) =>
					lines.slice().reverse().map((l, i) => (
						<li key={String(l.n)} class={i === 0 ? "now" : ""}>
							<b class="where">
								{l.bar}·{String(l.step + 1).padStart(2, "0")}
							</b>
							<span>read</span>
							<code>{l.folder}/</code>
							{l.notes.length
								? l.notes.map((n: Any) => (
									<span class="chip" title={n.route}>
										{n.name} <small>{n.route.split("/").pop()}</small>
									</span>
								))
								: <span class="none">nothing there</span>}
							{l.same.length
								? <em>pattern {l.pattern}, also {l.same.join(", ")}: the same nodes</em>
								: <em>pattern {l.pattern}</em>}
						</li>
					)))}
			</ol>
		</div>
	)
}

// ---- the voices ----
function chain(ctx: AudioContext) {
	const master = ctx.createGain(), comp = ctx.createDynamicsCompressor()
	master.gain.value = 0.75
	comp.threshold.value = -16
	comp.ratio.value = 4
	master.connect(comp).connect(ctx.destination)
	// an echo on a dotted eighth, darkening as it repeats
	const send = ctx.createGain(), echo = ctx.createDelay(2), fb = ctx.createGain()
	const dark = ctx.createBiquadFilter()
	dark.frequency.value = 2200
	fb.gain.value = 0.4
	send.gain.value = 0.32
	send.connect(echo).connect(dark).connect(fb).connect(echo)
	dark.connect(master)
	// a room: noise fading out, as an impulse
	const verb = ctx.createConvolver(), wet = ctx.createGain()
	const len = Math.floor(ctx.sampleRate * 1.8)
	const ir = ctx.createBuffer(2, len, ctx.sampleRate)
	for (let ch = 0; ch < 2; ch++) {
		const d = ir.getChannelData(ch)
		for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
	}
	verb.buffer = ir
	wet.gain.value = 0.25
	verb.connect(wet).connect(master)
	const synth = ctx.createGain(), drums = ctx.createGain()
	synth.connect(master)
	synth.connect(send)
	synth.connect(verb)
	drums.connect(master)
	const noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate)
	noise.getChannelData(0).forEach((_, i, d) => (d[i] = Math.random() * 2 - 1))
	return { ctx, synth, drums, send, echo, noise, tone: 0.55 }
}

// two saws a little apart and a sub, through a lowpass that closes as it rings
function pluck(c: Any, at: number, midi: number, dur: number, vel: number) {
	const ctx: AudioContext = c.ctx
	const f = 440 * 2 ** ((midi - 69) / 12)
	const lp = ctx.createBiquadFilter(), g = ctx.createGain()
	lp.Q.value = 3
	lp.frequency.setValueAtTime(500 + 6000 * c.tone, at)
	lp.frequency.exponentialRampToValueAtTime(420 + 600 * c.tone, at + 0.3)
	g.gain.setValueAtTime(0, at)
	g.gain.linearRampToValueAtTime(0.16 * vel, at + 0.006)
	g.gain.setTargetAtTime(0.06 * vel, at + 0.006, 0.12)
	g.gain.setTargetAtTime(0, at + dur, 0.07)
	lp.connect(g).connect(c.synth)
	const end = at + dur + 0.6
	for (
		const [type, mul, detune, level] of [["sawtooth", 1, -7, 1], ["sawtooth", 1, 7, 1], [
			"square",
			0.5,
			0,
			0.5,
		]] as const
	) {
		const o = ctx.createOscillator(), og = ctx.createGain()
		o.type = type
		o.frequency.value = f * mul
		o.detune.value = detune
		og.gain.value = level
		o.connect(og).connect(lp)
		o.start(at)
		o.stop(end)
		o.onended = () => (o.disconnect(), og.disconnect())
	}
	setTimeout(() => (lp.disconnect(), g.disconnect()), (end - ctx.currentTime + 0.2) * 1000)
}

function kick(c: Any, at: number, vel: number) {
	const ctx: AudioContext = c.ctx
	const o = ctx.createOscillator(), g = ctx.createGain()
	o.frequency.setValueAtTime(150, at)
	o.frequency.exponentialRampToValueAtTime(44, at + 0.13)
	g.gain.setValueAtTime(0.9 * vel, at)
	g.gain.exponentialRampToValueAtTime(0.001, at + 0.38)
	o.connect(g).connect(c.drums)
	o.start(at)
	o.stop(at + 0.4)
	o.onended = () => (o.disconnect(), g.disconnect())
}

function hat(c: Any, at: number, vel: number) {
	const ctx: AudioContext = c.ctx
	const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain()
	s.buffer = c.noise
	hp.type = "highpass"
	hp.frequency.value = 7500
	g.gain.setValueAtTime(0.3 * vel, at)
	g.gain.exponentialRampToValueAtTime(0.001, at + 0.05)
	s.connect(hp).connect(g).connect(c.drums)
	s.start(at)
	s.stop(at + 0.06)
	s.onended = () => (s.disconnect(), hp.disconnect(), g.disconnect())
}

// the black keys' rows, shaded across the grid: an octave of stripes from C5 down
const BLACK = Array.from({ length: 12 }, (_, i) => [1, 3, 6, 8, 10].includes((TOP - i + 120) % 12))
const STRIPES = BLACK.map((b, i) =>
	`${b ? "#0000000c" : "transparent"} ${i * ROW}px ${(i + 1) * ROW}px`
)
	.join(", ")

// ---- the look: lemon page, black lines, white cards with a pink glow, cherry, mint, blue ----
const LOOK = `
@import url("https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap");
@keyframes beat { to { opacity: 0 } }
.beat { position: fixed; width: 0; height: 0; pointer-events: none; animation: beat 20ms linear infinite }
* { box-sizing: border-box }
body { background: #ffff88; margin: 10px; font-family: Jost, system-ui, sans-serif; color: #000;
	display: flex; flex-direction: column; gap: 10px; width: max-content; max-width: 640px }
.card { background: #fff; border: 1px solid #000; border-radius: 6px; box-shadow: 0 0 10px 2px #66003322; padding: 8px 10px }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg);
	font-weight: 600; line-height: 1.4 }
button { font: inherit; padding: 2px 10px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 1px 1px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translateY(-1px); box-shadow: 2px 2px 0 #000 }
button:active { transform: none; box-shadow: none }
button:disabled { opacity: .35; cursor: default; transform: none; box-shadow: none }
input[type=range] { accent-color: #ff2284; width: 72px; vertical-align: middle }
label { font-size: 12px; display: inline-flex; align-items: center; gap: 4px }
.transport { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; width: 100% }
.transport .play { font-size: 15px; font-weight: 600; min-width: 84px }
.transport .play[data-on] { background: #40dcba }
.pos { margin-left: auto; font: 600 14px ui-monospace, Menlo, monospace; background: #000; color: #40dcba; padding: 2px 8px; border-radius: 2px }
.roller { display: flex; flex-direction: column; gap: 10px }
.song { display: flex; gap: 8px }
.bar { width: 150px; padding: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 4px }
.bar header { display: flex; align-items: center; gap: 6px; font-size: 11px }
.bar .shared { margin-left: auto; font-weight: 600 }
.bar[data-selected] { outline: 3px solid #000; outline-offset: 1px }
.bar[data-playing] { box-shadow: 0 0 0 4px #40dcba, 0 0 14px 4px #40dcba88 }
.bar .tag { color: #fff; -webkit-text-stroke: .3px #000 }
.mini { width: 100%; height: 36px; border: 1px solid #000; border-radius: 2px; display: block }
.acts { display: flex; gap: 4px }
.acts button { padding: 0 6px; font-size: 12px }
.roll header { display: flex; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 6px }
.sheet { display: flex; border: 1px solid #000; width: max-content }
.keys { width: 38px; border-right: 1px solid #000; flex: none }
.key { height: ${ROW}px; font: 600 9px/${ROW}px Jost, sans-serif; padding-left: 3px; border-bottom: 1px solid #0001; background: #fff }
.key.black { background: #000; color: #fff }
.key.drum { background: #ffff88; border-top: 1px solid #000 }
.grid { position: relative; cursor: crosshair; touch-action: none; user-select: none;
	background:
		linear-gradient(90deg, #000 1px, transparent 1px) 0 0 / ${4 * CELL}px 100%,
		linear-gradient(90deg, #0002 1px, transparent 1px) 0 0 / ${CELL}px 100%,
		linear-gradient(#0000000d 1px, transparent 1px) 0 0 / 100% ${ROW}px,
		linear-gradient(#ffff88, #ffff88) 0 ${25 * ROW}px / 100% ${2 * ROW}px no-repeat,
		linear-gradient(${STRIPES}) 0 0 / 100% ${12 * ROW}px repeat-y,
		#fff }
.paper { position: absolute; inset: 0 }
.col { position: absolute; top: 0; bottom: 0; width: ${CELL}px; pointer-events: none }
.note { position: absolute; left: 1px; height: ${
	ROW - 1
}px; background: #ff2284; border: 1px solid #000;
	border-radius: 2px; font: 600 8px/${
	ROW - 2
}px Jost, sans-serif; color: #fff; padding-left: 2px; overflow: hidden;
	white-space: nowrap; cursor: grab; box-shadow: 1px 1px 0 #000; z-index: 1; transition: box-shadow 120ms;
	pointer-events: auto }
.note[data-kind=kick] { background: #2269ff }
.note[data-kind=hat] { background: #40dcba; color: #000 }
.note[data-read] { box-shadow: 0 0 0 2px #ffff88, 0 0 10px 3px #ff2284; z-index: 2 }
.playhead { position: absolute; top: 0; bottom: 0; width: ${CELL}px; background: #40dcba44;
	border-left: 2px solid #40dcba; pointer-events: none; transition: left 60ms linear }
.trace header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 11px }
.trace header small { flex: 1; max-width: 360px }
.trace ol { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12px; min-height: 180px }
.trace li { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 2px 4px; border-radius: 2px; opacity: .55 }
.trace li.now { opacity: 1; background: #ffff88; border: 1px solid #000 }
.trace .where { font: 600 12px ui-monospace, Menlo, monospace; min-width: 58px }
.trace code { font: 11px ui-monospace, Menlo, monospace }
.chip { border: 1px solid #000; border-radius: 2px; padding: 0 5px; background: #ffd9ea; font-weight: 600 }
.chip small { font: 9px ui-monospace, Menlo, monospace; font-weight: 400 }
.trace em { margin-left: auto; font-size: 11px }
.none { color: #0007 }
`
