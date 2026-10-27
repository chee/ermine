/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	ensureNode,
	getArgs,
	hasNode,
	list,
	patch,
	peep,
	read,
	ref,
	unplace,
} from "@ermine/system"
import { bind, handler, under } from "ermine-h"

// fancy-synth: a little eurorack. every module is a process, /<name>, its args its name and its
// first values; what it keeps is saved at /rack/<name> (a reload finds it again):
//   knobs/<id>     a knob is a node: drag it, or edit it in the graph tab, and the sound follows
//   jacks/<id>     a jack is a node holding the live web audio node behind it (an output's sound,
//                  an input's gain), or a gate: {n, at, len}, a beat on the audio clock
//   voice          the module's web audio nodes, built once per audio context (kept on reload)
// a cable is a node under /patch, named for the input it feeds: /patch/filter.in = {from:
// "mixer.out"}. an input's wiring is an effect reading its cable's node and the two jacks, so
// re-patching reruns that one input's wiring, and a module rebuilt (edit its build below) is
// rewired by everyone reading its jacks. power on the out module: audio needs a click.
// nothing is open after a timer or a frame: the clock's loop is an element whose css animation
// cycles every 20ms, each cycle's animationiteration calling on/beat through a handler
const HP = 13 // px per eurorack unit
const LOOKAHEAD = 0.1 // s: how far ahead the clock writes its gates (the graph runs ahead of the speaker)
const COLORS = ["#ff2284", "#40dcba", "#2269ff", "#ffff88", "#000000"]

// ---- what a module is made of ----
type Knob = {
	id: string
	label: string
	min: number
	max: number
	init: number
	log?: boolean
	int?: boolean
	fmt?: (v: number) => string
}
type Switch = {
	id: string
	label: string
	options: string[]
	glyphs: string[]
	names: string[]
	init: string
}
type Jack = { id: string; label: string; kind: "audio" | "cv" | "gate" }
type Gate = { n: number; at: number; len: number }
// deno-lint-ignore no-explicit-any
type Any = any
type Voice = { jacks: Record<string, AudioNode>; stop: () => void; [k: string]: Any }
type Module = {
	name: string
	spec: Spec
	// a node of this module's, saved: /rack/<name>/<sub>
	own: (sub: string) => string
	// a live thing (a canvas) kept at /rack/<name>/<sub>: a reload finds it again
	keep: <T>(sub: string, make: () => T) => T
	// a whole put
	put: (x: Parameters<typeof read>[0], v: unknown) => void
	knob: Record<string, Any>
	jack: Record<string, Any>
	voice: Any
	ctx: () => AudioContext | undefined
}
type Spec = {
	title: string
	hp: number
	tint: string
	knobs: Knob[]
	switches?: Switch[]
	ins: Jack[]
	outs: Jack[]
	// the web audio nodes, made for a context; its jacks by name
	build?: (ctx: AudioContext) => Voice
	// a knob's value given to the voice
	set?: Record<string, (voice: Any, v: Any, ctx: AudioContext) => void>
	// a gate arrived at a gate input
	gate?: (voice: Any, gate: Gate, m: Module) => void
	setup?: (m: Module) => void
	face?: (m: Module) => Any
}

// a node's value now, from an action or an act (nothing tracked)
const get = <T,>(x: Parameters<typeof read>[0]) => peep(() => read(x)) as T
const put = (x: Parameters<typeof read>[0], v: unknown) => patch(x, [{ path: [], value: v }])

// ---- a knob's turn: 0..1 along its range, and back ----
const clamp = (n: number) => Math.min(1, Math.max(0, n))
function norm(k: Knob, v: unknown) {
	const x = Number(v)
	if (!Number.isFinite(x)) return norm(k, k.init)
	return clamp(
		k.log ? Math.log(x / k.min) / Math.log(k.max / k.min) : (x - k.min) / (k.max - k.min),
	)
}
function denorm(k: Knob, n: number) {
	const v = k.log ? k.min * (k.max / k.min) ** clamp(n) : k.min + clamp(n) * (k.max - k.min)
	return k.int ? Math.round(v) : Number(v.toPrecision(3))
}
const angle = (k: Knob, v: unknown) => -135 + 270 * norm(k, v)

const hz = (v: number) =>
	v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : v >= 100 ? v.toFixed(0) : v.toFixed(1)
const secs = (v: number) => (v < 1 ? Math.round(v * 1000) + "ms" : v.toFixed(2) + "s")
const pct = (v: number) => Math.round(v * 100) + "%"
const signed = (unit: string) => (v: number) => (v > 0 ? "+" : "") + Math.round(v) + unit
const WAVES = ["sine", "triangle", "sawtooth", "square"]
const WAVE_GLYPHS = ["∿", "⋀", "⩘", "⊓"]
const WAVE_NAMES = ["sine", "tri", "saw", "square"]
const smooth = (p: AudioParam, v: number, ctx: AudioContext, s = 0.015) =>
	p.setTargetAtTime(v, ctx.currentTime, s)

// ---- the modules ----
const CLOCK: Spec = {
	title: "clock",
	hp: 5,
	tint: "#ffffc2",
	knobs: [{ id: "bpm", label: "tempo", min: 40, max: 240, init: 120, int: true }],
	ins: [],
	outs: [{ id: "gate", label: "gate", kind: "gate" }],
	// a gate is written ahead of time, on the audio clock: whoever reads it schedules at its at
	setup(m) {
		const state = m.keep("state", () => ({ n: 0, next: 0 }))
		// a beat (every 20ms, from the clock's face): what it reads now is what it uses now
		createAction("on/beat", () => {
			const ctx = peep(() => m.ctx())
			if (!ctx || ctx.state !== "running") return
			const step = 30 / (Number(get(m.knob.bpm)) || 120) // eighths
			if (state.next < ctx.currentTime) state.next = ctx.currentTime + 0.02
			while (state.next < ctx.currentTime + LOOKAHEAD) {
				m.put(m.jack.gate, { n: state.n++, at: state.next, len: step / 2 })
				state.next += step
			}
		})
	},
	face: (m) => (
		<div class="face">
			<i
				class="led big"
				data-flash={bind(m.own("jacks/gate"), (g: Gate) => (g.n % 2 ? "a" : "b"))}
			/>
			<small>bpm, in 8ths</small>
			<i class="beat" onAnimationIteration={handler("on/beat")} />
		</div>
	),
}

const STEP_INIT = [0, 3, 7, 10]
const STEPS: Spec = {
	title: "steps",
	hp: 8,
	tint: "#ffd9ea",
	knobs: STEP_INIT.map((init, i) => ({
		id: "s" + (i + 1),
		label: "step " + (i + 1),
		min: -12,
		max: 12,
		init,
		int: true,
		fmt: signed(""),
	})),
	ins: [{ id: "clock", label: "clock", kind: "gate" }],
	outs: [{ id: "cv", label: "pitch", kind: "cv" }],
	build(ctx) {
		const cv = ctx.createConstantSource()
		cv.offset.value = 0
		cv.start()
		return {
			jacks: { cv },
			cv,
			semis: [0, 0, 0, 0],
			stop() {
				cv.stop()
				cv.disconnect()
			},
		}
	},
	set: Object.fromEntries(
		STEP_INIT.map((_, i) => ["s" + (i + 1), (x: Any, v: number) => void (x.semis[i] = v)]),
	),
	// one step on per gate: the pitch is set at the gate's own time; step says which (the graph's)
	gate(voice, g, m) {
		const step = ensureNode(m.own("step"), -1)
		const i = (Number(get(step)) + 1) % 4
		voice.cv.offset.setValueAtTime(voice.semis[i], g.at)
		m.put(step, i)
	},
	setup: (m) => void ensureNode(m.own("step"), -1),
	face: (m) => (
		<div class="face leds">
			{[0, 1, 2, 3].map((i) => (
				<i
					class="led"
					data-on={bind(m.own("step"), (s: number) => (s === i ? "on" : undefined))}
				/>
			))}
		</div>
	),
}

const OSC: Spec = {
	title: "oscillator",
	hp: 8,
	tint: "#ffd9ea",
	knobs: [
		{ id: "tune", label: "tune", min: 27.5, max: 1760, init: 110, log: true, fmt: hz },
		{ id: "fine", label: "fine", min: -50, max: 50, init: 0, fmt: signed("¢") },
		{ id: "fm", label: "fm depth", min: 0, max: 1200, init: 0, fmt: signed("¢") },
	],
	switches: [{
		id: "wave",
		label: "wave",
		options: WAVES,
		glyphs: WAVE_GLYPHS,
		names: WAVE_NAMES,
		init: "sawtooth",
	}],
	ins: [
		{ id: "pitch", label: "pitch", kind: "cv" },
		{ id: "fm", label: "fm", kind: "cv" },
	],
	outs: [{ id: "out", label: "out", kind: "audio" }],
	build(ctx) {
		const o = ctx.createOscillator()
		const pitch = ctx.createGain(), fm = ctx.createGain(), out = ctx.createGain()
		pitch.gain.value = 100 // a semitone per unit of cv
		fm.gain.value = 0
		out.gain.value = 0.4
		pitch.connect(o.detune)
		fm.connect(o.detune)
		o.connect(out)
		o.start()
		return {
			jacks: { pitch, fm, out },
			o,
			depth: fm,
			stop() {
				o.stop()
				for (const n of [o, pitch, fm, out]) n.disconnect()
			},
		}
	},
	set: {
		tune: (x, v, ctx) => smooth(x.o.frequency, v, ctx),
		fine: (x, v, ctx) => smooth(x.o.detune, v, ctx),
		fm: (x, v, ctx) => smooth(x.depth.gain, v, ctx),
		wave: (x, v) => void (x.o.type = v),
	},
}

const LFO: Spec = {
	title: "lfo",
	hp: 8,
	tint: "#c8f6ea",
	knobs: [
		{
			id: "rate",
			label: "rate",
			min: 0.02,
			max: 20,
			init: 0.15,
			log: true,
			fmt: (v) => hz(v) + "Hz",
		},
		{ id: "depth", label: "depth", min: 0, max: 1, init: 0.8, fmt: pct },
	],
	switches: [{
		id: "wave",
		label: "wave",
		options: WAVES,
		glyphs: WAVE_GLYPHS,
		names: WAVE_NAMES,
		init: "triangle",
	}],
	ins: [],
	outs: [{ id: "out", label: "out", kind: "cv" }],
	build(ctx) {
		const o = ctx.createOscillator(), out = ctx.createGain()
		o.connect(out)
		o.start()
		return {
			jacks: { out },
			o,
			out,
			stop() {
				o.stop()
				o.disconnect()
				out.disconnect()
			},
		}
	},
	set: {
		rate: (x, v, ctx) => smooth(x.o.frequency, v, ctx),
		depth: (x, v, ctx) => smooth(x.out.gain, v, ctx),
		wave: (x, v) => void (x.o.type = v),
	},
	// the lamp breathes at the rate: a style bound to the rate node
	face: (m) => (
		<div class="face">
			<i
				class="led breathe"
				style={bind(m.own("knobs/rate"), (r: number) => ({ animationDuration: 0.5 / r + "s" }))}
			/>
		</div>
	),
}

const MIXER: Spec = {
	title: "mixer",
	hp: 8,
	tint: "#ffffff",
	knobs: [1, 2, 3].map((i) => ({
		id: "l" + i,
		label: "level " + i,
		min: 0,
		max: 1,
		init: [0.7, 0.35, 0.5][i - 1],
		fmt: pct,
	})),
	ins: [1, 2, 3].map((i) => ({ id: "in" + i, label: "in " + i, kind: "audio" as const })),
	outs: [{ id: "out", label: "mix", kind: "audio" }],
	build(ctx) {
		const out = ctx.createGain()
		const ins = [1, 2, 3].map(() => ctx.createGain())
		for (const g of ins) g.connect(out)
		return {
			jacks: { in1: ins[0], in2: ins[1], in3: ins[2], out },
			ins,
			stop: () => [...ins, out].forEach((n) => n.disconnect()),
		}
	},
	set: Object.fromEntries(
		[0, 1, 2].map((
			i,
		) => [
			"l" + (i + 1),
			(x: Any, v: number, ctx: AudioContext) => smooth(x.ins[i].gain, v, ctx),
		]),
	),
}

const FILTER: Spec = {
	title: "filter",
	hp: 8,
	tint: "#d4e4ff",
	knobs: [
		{ id: "cutoff", label: "cutoff", min: 30, max: 12000, init: 750, log: true, fmt: hz },
		{ id: "res", label: "res", min: 0.5, max: 25, init: 7, log: true, fmt: (v) => v.toFixed(1) },
		{ id: "mod", label: "cv depth", min: 0, max: 3000, init: 500, fmt: hz },
	],
	switches: [{
		id: "type",
		label: "type",
		options: ["lowpass", "bandpass", "highpass"],
		glyphs: ["LP", "BP", "HP"],
		names: ["low", "band", "high"],
		init: "lowpass",
	}],
	ins: [
		{ id: "in", label: "in", kind: "audio" },
		{ id: "cv", label: "cv", kind: "cv" },
	],
	outs: [{ id: "out", label: "out", kind: "audio" }],
	build(ctx) {
		const input = ctx.createGain(), cv = ctx.createGain(), f = ctx.createBiquadFilter()
		input.connect(f)
		cv.connect(f.frequency)
		return {
			jacks: { in: input, cv, out: f },
			f,
			cv,
			stop: () => [input, cv, f].forEach((n) => n.disconnect()),
		}
	},
	set: {
		cutoff: (x, v, ctx) => smooth(x.f.frequency, v, ctx),
		res: (x, v, ctx) => smooth(x.f.Q, v, ctx),
		mod: (x, v, ctx) => smooth(x.cv.gain, v, ctx),
		type: (x, v) => void (x.f.type = v),
	},
}

const ENV: Spec = {
	title: "envelope · vca",
	hp: 10,
	tint: "#c8f6ea",
	knobs: [
		{ id: "a", label: "attack", min: 0.002, max: 2, init: 0.004, log: true, fmt: secs },
		{ id: "d", label: "decay", min: 0.02, max: 2, init: 0.22, log: true, fmt: secs },
		{ id: "s", label: "sustain", min: 0, max: 1, init: 0.15, fmt: pct },
		{ id: "r", label: "release", min: 0.02, max: 3, init: 0.35, log: true, fmt: secs },
	],
	ins: [
		{ id: "gate", label: "gate", kind: "gate" },
		{ id: "in", label: "in", kind: "audio" },
	],
	outs: [
		{ id: "out", label: "out", kind: "audio" },
		{ id: "env", label: "env", kind: "cv" },
	],
	build(ctx) {
		const input = ctx.createGain(), vca = ctx.createGain(), env = ctx.createConstantSource()
		vca.gain.value = 0
		env.offset.value = 0
		env.connect(vca.gain)
		input.connect(vca)
		env.start()
		return {
			jacks: { in: input, out: vca, env },
			env,
			adsr: { a: 0.004, d: 0.22, s: 0.15, r: 0.35 },
			stop() {
				env.stop()
				for (const n of [input, vca, env]) n.disconnect()
			},
		}
	},
	set: Object.fromEntries(
		["a", "d", "s", "r"].map((k) => [k, (x: Any, v: number) => void (x.adsr[k] = v)]),
	),
	// attack to 1, fall to sustain, let go at the gate's end: all on the audio clock, at its at
	gate(voice, g, m) {
		const { a, d, s, r } = voice.adsr
		const p: AudioParam = voice.env.offset
		if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(g.at)
		else p.cancelScheduledValues(g.at)
		p.linearRampToValueAtTime(1, g.at + a)
		p.setTargetAtTime(s, g.at + a, d / 3)
		p.setTargetAtTime(0, g.at + Math.max(a, g.len), r / 3)
		m.put(ensureNode(m.own("hit"), 0), g.n)
	},
	setup(m) {
		ensureNode(m.own("hit"), 0)
		// the shape, drawn from the four knobs (a canvas stays a canvas)
		const canvas = m.keep(
			"shape",
			() => Object.assign(document.createElement("canvas"), { width: 240, height: 84 }),
		)
		canvas.className = "screen shape"
		createEffect(
			"shape",
			() => ["a", "d", "s", "r"].map((k) => Number(read(m.knob[k]))),
			([a, d, s, r]) => drawShape(canvas, a, d, s, r),
		)
	},
	face: (m) => (
		<div class="face side">
			{m.keep("shape", () => document.createElement("canvas"))}
			<i class="led" data-flash={bind(m.own("hit"), (n: number) => (n % 2 ? "a" : "b"))} />
		</div>
	),
}

function drawShape(canvas: HTMLCanvasElement, a: number, d: number, s: number, r: number) {
	const g = canvas.getContext("2d")!
	const W = canvas.width, H = canvas.height, pad = 8
	const total = a + d + 0.25 + r
	const x = (t: number) => pad + (t / total) * (W - 2 * pad)
	const y = (v: number) => H - pad - v * (H - 2 * pad)
	g.clearRect(0, 0, W, H)
	g.strokeStyle = "#ffd9ea"
	g.lineWidth = 2
	for (let i = 1; i < 4; i++) {
		g.beginPath()
		g.moveTo(0, (i * H) / 4)
		g.lineTo(W, (i * H) / 4)
		g.stroke()
	}
	g.beginPath()
	g.moveTo(x(0), y(0))
	g.lineTo(x(a), y(1))
	g.lineTo(x(a + d), y(s))
	g.lineTo(x(a + d + 0.25), y(s))
	g.lineTo(x(total), y(0))
	g.lineTo(x(0), y(0))
	g.fillStyle = "#40dcba55"
	g.fill()
	g.strokeStyle = "#ff2284"
	g.lineWidth = 4
	g.lineJoin = "round"
	g.stroke()
}

const DELAY: Spec = {
	title: "delay",
	hp: 8,
	tint: "#d4e4ff",
	knobs: [
		{ id: "time", label: "time", min: 0.02, max: 1.5, init: 0.375, log: true, fmt: secs },
		{ id: "fb", label: "feedback", min: 0, max: 0.92, init: 0.45, fmt: pct },
		{ id: "mix", label: "mix", min: 0, max: 1, init: 0.35, fmt: pct },
	],
	ins: [{ id: "in", label: "in", kind: "audio" }],
	outs: [{ id: "out", label: "out", kind: "audio" }],
	build(ctx) {
		const input = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain()
		const out = ctx.createGain(), line = ctx.createDelay(2), fb = ctx.createGain()
		const tone = ctx.createBiquadFilter()
		tone.type = "lowpass"
		tone.frequency.value = 2600
		input.connect(dry).connect(out)
		input.connect(line).connect(tone).connect(fb).connect(line)
		tone.connect(wet).connect(out)
		return {
			jacks: { in: input, out },
			line,
			fb,
			wet,
			dry,
			stop: () => [input, dry, wet, out, line, fb, tone].forEach((n) => n.disconnect()),
		}
	},
	set: {
		// a slow glide: turning time bends the echoes, like tape
		time: (x, v, ctx) => smooth(x.line.delayTime, v, ctx, 0.08),
		fb: (x, v, ctx) => smooth(x.fb.gain, v, ctx),
		mix: (x, v, ctx) => (smooth(x.wet.gain, v, ctx), smooth(x.dry.gain, 1 - v / 2, ctx)),
	},
}

const SCOPE: Spec = {
	title: "scope",
	hp: 12,
	tint: "#ffffff",
	knobs: [
		{ id: "zoom", label: "zoom", min: 1, max: 16, init: 3, log: true, fmt: (v) => "×" + v },
		{ id: "gain", label: "gain", min: 0.25, max: 8, init: 1.5, log: true, fmt: (v) => "×" + v },
	],
	ins: [{ id: "in", label: "in", kind: "audio" }],
	outs: [],
	build(ctx) {
		const input = ctx.createGain(), an = ctx.createAnalyser(), mute = ctx.createGain()
		an.fftSize = 4096
		mute.gain.value = 0
		// pulled by the destination, silently: an analyser nobody listens to may not run
		input.connect(an).connect(mute).connect(ctx.destination)
		return {
			jacks: { in: input },
			an,
			stop: () => [input, an, mute].forEach((n) => n.disconnect()),
		}
	},
	setup(m) {
		const canvas = m.keep(
			"screen",
			() => Object.assign(document.createElement("canvas"), { width: 340, height: 220 }),
		)
		canvas.className = "screen"
		let voice: Any, zoom = 3, gain = 1.5
		createEffect("voice", () => read(m.voice), (v) => void (voice = v))
		createEffect(
			"knobs",
			() => [read(m.knob.zoom), read(m.knob.gain)],
			([z, g]) => void ((zoom = Number(z) || 1), (gain = Number(g) || 1)),
		)
		const buf = new Float32Array(4096)
		let raf = requestAnimationFrame(function frame() {
			drawScope(canvas, voice, buf, zoom, gain)
			raf = requestAnimationFrame(frame)
		})
		addTeardown(() => cancelAnimationFrame(raf))
	},
	face: (m) => <div class="face">{m.keep("screen", () => document.createElement("canvas"))}</div>,
}

// the signal, from a rising zero crossing so it stands still; cherry on paper
function drawScope(
	canvas: HTMLCanvasElement,
	voice: Any,
	buf: Float32Array,
	zoom: number,
	gain: number,
) {
	const g = canvas.getContext("2d")!
	const W = canvas.width, H = canvas.height
	g.fillStyle = "#fff"
	g.fillRect(0, 0, W, H)
	g.strokeStyle = "#ffd9ea"
	g.lineWidth = 2
	for (let i = 1; i < 8; i++) {
		g.beginPath()
		g.moveTo((i * W) / 8, 0)
		g.lineTo((i * W) / 8, H)
		g.stroke()
	}
	for (let i = 1; i < 4; i++) {
		g.beginPath()
		g.moveTo(0, (i * H) / 4)
		g.lineTo(W, (i * H) / 4)
		g.stroke()
	}
	const running = voice?.an && voice.an.context.state === "running"
	if (!running) {
		g.fillStyle = "#0008"
		g.font = "600 22px Jost, system-ui"
		g.textAlign = "center"
		g.fillText("⏻ out, to hear it", W / 2, H / 2 + 8)
		return
	}
	voice.an.getFloatTimeDomainData(buf)
	const span = Math.floor(buf.length / 2 / zoom)
	let start = 0
	for (let i = 1; i < buf.length / 2; i++) {
		if (buf[i - 1] < 0 && buf[i] >= 0) {
			start = i
			break
		}
	}
	g.beginPath()
	for (let i = 0; i < span; i++) {
		const x = (i / span) * W
		const y = H / 2 - buf[start + i] * gain * (H / 2.2)
		i ? g.lineTo(x, y) : g.moveTo(x, y)
	}
	g.lineJoin = "round"
	g.shadowColor = "#ff228488"
	g.shadowBlur = 8
	g.strokeStyle = "#ff2284"
	g.lineWidth = 3
	g.stroke()
	g.shadowBlur = 0
}

const OUT: Spec = {
	title: "output",
	hp: 7,
	tint: "#ffffc2",
	knobs: [{ id: "vol", label: "volume", min: 0, max: 1, init: 0.5, fmt: pct }],
	ins: [{ id: "in", label: "in", kind: "audio" }],
	outs: [],
	build(ctx) {
		const input = ctx.createGain(), vol = ctx.createGain(), an = ctx.createAnalyser()
		const limit = ctx.createDynamicsCompressor()
		limit.threshold.value = -10
		limit.ratio.value = 8
		input.connect(vol).connect(limit).connect(ctx.destination)
		vol.connect(an)
		return {
			jacks: { in: input },
			vol,
			an,
			stop: () => [input, vol, an, limit].forEach((n) => n.disconnect()),
		}
	},
	set: { vol: (x, v, ctx) => smooth(x.vol.gain, v, ctx) },
	// the audio context is a node (/audio) the out module makes on the first press: audio needs
	// a person's click. power is a node too: edit it in the graph tab and the context follows
	setup(m) {
		const power = ensureNode(m.own("power"), false)
		createAction("on/power", () => {
			ref("./audio", () => new AudioContext({ latencyHint: "interactive" }))
			m.put(power, !get(power))
		})
		createEffect(
			"power",
			() => [read(power), m.ctx()] as const,
			([on, ctx]) => {
				if (!ctx) return
				if (on && ctx.state !== "running") ctx.resume()
				if (!on && ctx.state === "running") ctx.suspend()
			},
		)
		// the level, as a lamp column
		const meter = m.keep(
			"meter",
			() => Object.assign(document.createElement("canvas"), { width: 24, height: 80 }),
		)
		meter.className = "screen meter"
		let voice: Any
		createEffect("voice", () => read(m.voice), (v) => void (voice = v))
		const buf = new Float32Array(1024)
		let raf = requestAnimationFrame(function frame() {
			let peak = 0
			if (voice?.an && voice.an.context.state === "running") {
				voice.an.getFloatTimeDomainData(buf)
				for (const x of buf) peak = Math.max(peak, Math.abs(x))
			}
			const g = meter.getContext("2d")!
			g.clearRect(0, 0, 24, 80)
			const lit = Math.round(Math.min(1, peak * 1.6) * 7)
			for (let i = 0; i < 7; i++) {
				g.fillStyle = i < lit ? (i > 4 ? "#ff2284" : "#40dcba") : "#fff"
				g.fillRect(4, 70 - i * 11, 16, 8)
				g.strokeStyle = "#000"
				g.strokeRect(4.5, 70.5 - i * 11, 15, 7)
			}
			raf = requestAnimationFrame(frame)
		})
		addTeardown(() => cancelAnimationFrame(raf))
	},
	face: (m) => (
		<div class="face side">
			<button
				class="power"
				data-on={bind(m.own("power"), (p: boolean) => (p ? "on" : undefined))}
				onClick={handler("on/power")}
				title="power: makes the audio context on the first press"
			>
				⏻
			</button>
			{m.keep("meter", () => document.createElement("canvas"))}
		</div>
	),
}

// ---- a module: one program for every spec. knobs, jacks, the voice, the wiring, the panel ----
function module(spec: Spec) {
	return function program() {
		// the host gives the process its name, then its first values: "tune=110" "wave=sawtooth"
		const [name, ...given] = getArgs()
		const args = Object.fromEntries(given.map((a) => {
			const [k, v] = a.split("=")
			return [k, v !== "" && Number.isFinite(Number(v)) ? Number(v) : v]
		}))
		const own = (sub: string) => `/rack/${name}/${sub}`
		const keep = <T,>(sub: string, make: () => T) => peep(() => read(ref(own(sub), make))) as T
		const voice = ensureNode(own("voice"), null)
		const knob: Record<string, Any> = {}, jack: Record<string, Any> = {}
		for (const k of [...spec.knobs, ...(spec.switches ?? [])]) {
			knob[k.id] = ensureNode(own(`knobs/${k.id}`), args[k.id] ?? k.init)
		}
		for (const j of [...spec.ins, ...spec.outs]) {
			jack[j.id] = ensureNode(own(`jacks/${j.id}`), null)
		}
		// the audio context, once the out module has made it (told by hasNode, tracked)
		const ctx = () => {
			const c = hasNode("./audio") ? read("./audio") : undefined
			return c instanceof AudioContext ? c : undefined
		}
		const m: Module = { name, spec, own, keep, put, knob, jack, voice, ctx }

		// a knob's value as the voice wants it: in range, or one of the switch's options
		const value = (id: string, v: unknown) => {
			const k = spec.knobs.find((k) => k.id === id)
			if (k) return denorm(k, norm(k, v))
			const w = spec.switches!.find((w) => w.id === id)!
			return w.options.includes(v as string) ? v : w.init
		}
		createAction("on/knob", (id: string, v: number) => put(knob[id], value(id, v)))
		createAction("on/switch", (id: string) => {
			const w = spec.switches!.find((w) => w.id === id)!
			const i = w.options.indexOf(get(knob[id]) as string)
			put(knob[id], w.options[(i + 1) % w.options.length])
		})

		// the voice: built once per audio context, and again only when build's code changed
		// (a reload keeps it, so the sound keeps going). its jacks go in the jack nodes
		if (spec.build) {
			createEffect("build", () => ctx(), (c) => {
				if (!c) return
				const was = get<Any>(voice)
				const code = String(spec.build)
				if (was?.ctx === c && was.code === code) return
				was?.stop()
				const v = { ...spec.build!(c), ctx: c, code }
				put(voice, v)
				for (const [id, n] of Object.entries(v.jacks)) if (jack[id]) put(jack[id], n)
			})
			// a knob's effect reads that knob and the voice: turning it sets one param
			for (const [id, set] of Object.entries(spec.set ?? {})) {
				createEffect(
					`set-${id}`,
					() => [read(knob[id]), read(voice)] as const,
					([v, x]) => void (x && set(x, value(id, v), (x as Any).ctx)),
				)
			}
		}

		// the inputs: each an effect reading its cable's node (only its from), the jack it names
		// and this input's own jack. what it connected is kept, so a reload connects nothing twice
		const wires = keep("wires", () => ({})) as Record<string, Any>
		for (const j of spec.ins) {
			const id = `${name}.${j.id}`
			createEffect(`wire-${j.id}`, () => {
				// a cable that is not there (or names no jack) is no source, not a wait: unplugging
				// reruns this, and the wire comes down
				const cable = `/patch/${id}`
				const from = hasNode(cable) ? read(cable, ["from"]) : undefined
				const [mod, out] = typeof from === "string" ? from.split(".") : []
				const at = `/rack/${mod}/jacks/${out}`
				const src = mod && out && hasNode(at) ? read(at) : undefined
				return { from, src, dst: read(jack[j.id]) }
			}, ({ from, src, dst }: Any) => {
				if (j.kind === "gate") {
					// a gate: a beat with a time. each new one is acted on once
					if (typeof src?.n !== "number" || wires[j.id]?.n === src.n) return
					wires[j.id] = { n: src.n, from }
					const x = get<Any>(voice)
					if (x && src.at >= x.ctx.currentTime - 0.02) spec.gate?.(x, src, m)
					return
				}
				const was = wires[j.id]
				if (was?.src === src && was?.dst === dst) return
				if (was?.src && was?.dst) {
					try {
						was.src.disconnect(was.dst)
					} catch { /* already gone with its context */ }
				}
				const ok = src instanceof AudioNode && dst instanceof AudioNode &&
					src.context === dst.context
				if (ok) src.connect(dst)
				wires[j.id] = ok ? { src, dst, from } : undefined
				ping(id)
			})
		}
		// the voice as it is now, for the teardown (nothing is open to read it there)
		let live: Any
		createEffect("live", () => read(voice), (v) => void (live = v))
		addTeardown((why) => {
			if (why !== "ended") return
			for (const w of Object.values(wires)) {
				try {
					w?.src?.disconnect?.(w.dst)
				} catch { /* gone */ }
			}
			live?.stop?.()
		})

		spec.setup?.(m)
		return <Panel m={m} />
	}
}

// a jack that was just wired again rings, so a re-patch shows which input reran
function ping(id: string) {
	document.querySelector(`[data-jack="${id}"] .hole`)?.animate(
		[{ boxShadow: "0 0 0 0 #40dcba" }, { boxShadow: "0 0 0 12px #40dcba00" }],
		{ duration: 600 },
	)
}

// ---- the panel: knobs, the module's face, its jacks ----
function Panel({ m }: { m: Module }) {
	const { spec, name } = m
	return (
		<div
			class="module"
			data-module={name}
			style={{ width: spec.hp * HP + "px", background: spec.tint }}
		>
			<header>
				<span class="tag">{name}</span>
				<small>{spec.title}</small>
			</header>
			<div class="knobs">
				{spec.knobs.map((k) => <KnobView m={m} k={k} />)}
				{(spec.switches ?? []).map((w) => <SwitchView m={m} w={w} />)}
			</div>
			{spec.face?.(m)}
			<div class="jacks">
				{spec.ins.map((j) => <JackView name={name} j={j} dir="in" />)}
				{spec.outs.map((j) => <JackView name={name} j={j} dir="out" />)}
			</div>
		</div>
	)
}

// a knob: drag up and down (shift: finely), the wheel, a double-click for its first value. the
// cap's turn, the number under it and data-value are all bound to the knob's node
function KnobView({ m, k }: { m: Module; k: Knob }) {
	const path = m.own(`knobs/${k.id}`)
	let grab: { y: number; n: number } | undefined
	return (
		<div
			class="knob"
			title={`${k.label}: drag up or down, shift for fine, double-click: ${k.init}`}
		>
			<div
				class="dial"
				aria-label={`${k.label} knob`}
				data-value={bind(path)}
				onPointerDown={(e: PointerEvent) => {
					const el = e.currentTarget as HTMLElement
					el.setPointerCapture(e.pointerId)
					grab = { y: e.clientY, n: norm(k, el.dataset.value) }
				}}
				onPointerMove={handler("on/knob", (e: PointerEvent) => {
					if (!grab) return
					return [k.id, denorm(k, grab.n + (grab.y - e.clientY) / (e.shiftKey ? 800 : 160))]
				})}
				onPointerUp={() => {
					grab = undefined
				}}
				onLostPointerCapture={() => {
					grab = undefined
				}}
				onDblClick={handler("on/knob", [k.id, k.init])}
				onWheel={handler("on/knob", (e: WheelEvent) => {
					e.preventDefault()
					const el = e.currentTarget as HTMLElement
					return [k.id, denorm(k, norm(k, el.dataset.value) - e.deltaY / 1500)]
				})}
			>
				<div
					class="cap"
					style={bind(path, (v) => ({ transform: `rotate(${angle(k, v)}deg)` }))}
				/>
			</div>
			<b class="val">{bind(path, (v) => (k.fmt ?? String)(Number(v)))}</b>
			<span class="label">{k.label}</span>
		</div>
	)
}

function SwitchView({ m, w }: { m: Module; w: Switch }) {
	const path = m.own(`knobs/${w.id}`)
	return (
		<div class="knob switch" title={`${w.label}: ${w.options.join(", ")}`}>
			<button class="flip" onClick={handler("on/switch", [w.id])}>
				{bind(path, (v) => w.glyphs[w.options.indexOf(v)] ?? "?")}
			</button>
			<b class="val">{bind(path, (v) => w.names[w.options.indexOf(v)] ?? "?")}</b>
			<span class="label">{w.label}</span>
		</div>
	)
}

// a jack: pressing it takes a cable from the patch bay (its handlers, called from here). an
// input says which cable is in it (data-patched, bound to its node in /patch)
function JackView({ name, j, dir }: { name: string; j: Jack; dir: "in" | "out" }) {
	const id = `${name}.${j.id}`
	return (
		<div
			class={`jack ${dir} ${j.kind}`}
			data-jack={id}
			data-dir={dir}
			title={`${id} (${j.kind} ${dir === "in" ? "input" : "output"})`}
			data-patched={dir === "in" ? bind(`/patch/${id}`, (c) => c.from) : undefined}
			onPointerDown={handler("/patchbay/on/grab", (e: PointerEvent) => {
				e.preventDefault()
				;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
				return [id, dir, e.clientX, e.clientY]
			})}
			onPointerMove={handler("/patchbay/on/drag", (e: PointerEvent) => {
				const el = e.currentTarget as HTMLElement
				if (!el.hasPointerCapture(e.pointerId)) return
				return [e.clientX, e.clientY]
			})}
			onPointerUp={handler("/patchbay/on/drop", (e: PointerEvent) => {
				const at = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(
					"[data-jack]",
				)
				return [at?.dataset.jack, at?.dataset.dir]
			})}
		>
			<i class="hole" />
			<span>{j.label}</span>
		</div>
	)
}

// ---- the programs the host places ----
export const clock = module(CLOCK)
export const steps = module(STEPS)
export const osc = module(OSC)
export const lfo = module(LFO)
export const mixer = module(MIXER)
export const filter = module(FILTER)
export const env = module(ENV)
export const delay = module(DELAY)
export const scope = module(SCOPE)
export const out = module(OUT)

// ---- the patch bay: the cables are its nodes, at /patch; it draws them over the rack ----
const DEFAULT_PATCH = [
	["clock.gate", "steps.clock"],
	["clock.gate", "env.gate"],
	["steps.cv", "osc1.pitch"],
	["steps.cv", "osc2.pitch"],
	["osc1.out", "mixer.in1"],
	["osc2.out", "mixer.in2"],
	["mixer.out", "filter.in"],
	["lfo.out", "filter.cv"],
	["filter.out", "env.in"],
	["env.out", "delay.in"],
	["delay.out", "out.in"],
	["delay.out", "scope.in"],
]

export function patchbay() {
	// the first time only: a patch that sounds like something
	const names = () => (hasNode("/patch") ? list("/patch") : [])
	const seed = () =>
		DEFAULT_PATCH.forEach(([from, to], i) =>
			ensureNode(`/patch/${to}`, { from, color: COLORS[i % COLORS.length] })
		)
	if (names().length === 0) seed()
	// the cable in hand while dragging: where it is from (or to), and the pointer. it is the
	// process's own: a reload drops it
	const held = ensureNode("held", null)
	const cable = (to: string) => hasNode(`/patch/${to}`)
	const color = () => COLORS[peep(names).length % COLORS.length]
	const plug = (from: string, to: string, color: string) => {
		if (cable(to)) put(`/patch/${to}`, { from, color })
		else ensureNode(`/patch/${to}`, { from, color })
	}

	createAction("on/grab", (jack: string, dir: string, x: number, y: number) => {
		if (!jack) return
		if (dir === "out") return put(held, { from: jack, x, y, color: color() })
		if (!cable(jack)) return put(held, { to: jack, x, y, color: color() })
		// a plug pulled out of an input: the cable is in hand again, from where it was from
		const was = get<Any>(`/patch/${jack}`)
		unplace(`/patch/${jack}`)
		put(held, { from: was.from, x, y, color: was.color })
	})
	createAction("on/drag", (x: number, y: number) => {
		const h = get<Any>(held)
		if (h) put(held, { ...h, x, y })
	})
	createAction("on/drop", (jack?: string, dir?: string) => {
		const h = get<Any>(held)
		if (!h) return
		put(held, null)
		if (h.from && dir === "in" && jack) plug(h.from, jack, h.color)
		else if (h.to && dir === "out" && jack) plug(jack, h.to, h.color)
	})
	createAction("on/unplug", (to: string) => void (cable(to) && unplace(`/patch/${to}`)))
	createAction("on/reset", () => {
		for (const c of peep(names)) unplace(`/patch/${c}`)
		seed()
	})

	// the cables: an effect reads every cable node and the one in hand; a frame loop draws them
	// where the jacks are now (a layout change moves them; the graph doesn't know layout)
	const canvas = peep(() =>
		read(ref("./cables", () => document.createElement("canvas")))
	) as HTMLCanvasElement
	canvas.className = "wires"
	let shown: Any = { cables: [], held: null }
	createEffect(
		"cables",
		() => ({
			cables: names().map((c) => ({ to: c, ...(read(`/patch/${c}`) as Any) })),
			held: read(held),
		}),
		(v) => void (shown = v),
	)
	let raf = requestAnimationFrame(function frame() {
		drawCables(canvas, shown)
		raf = requestAnimationFrame(frame)
	})
	addTeardown(() => cancelAnimationFrame(raf))

	return (
		<div class="bay">
			<style>{LOOK}</style>
			{canvas}
			<div class="card cables">
				<header>
					<span class="tag">patch</span>
					<small>
						drag from a cherry output to an input · pull a plug out to unplug · knobs: drag,
						wheel, double-click
					</small>
					<button onClick={handler("on/reset")}>↺ the first patch</button>
				</header>
				<ul>
					{under("/patch", (c) => (
						<li>
							<i class="swatch" style={bind(c, (v) => ({ background: v.color }))} />
							<code>{bind(c, (v) => v.from)}</code> → <code>{c.name}</code>
							<button class="x" onClick={handler("on/unplug", [c.name])}>×</button>
						</li>
					))}
				</ul>
			</div>
		</div>
	)
}

// a cable hangs: a curve that sags with its length, a black line, its colour, a plug each end
function drawCables(canvas: HTMLCanvasElement, { cables, held }: Any) {
	const r = canvas.getBoundingClientRect()
	const dpr = devicePixelRatio || 1
	const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr)
	if (canvas.width !== W || canvas.height !== H) {
		canvas.width = W
		canvas.height = H
	}
	const g = canvas.getContext("2d")!
	g.setTransform(dpr, 0, 0, dpr, 0, 0)
	g.clearRect(0, 0, r.width, r.height)
	const at = (id: string) => {
		const el = document.querySelector(`[data-jack="${id}"] .hole`)
		if (!el) return
		const b = el.getBoundingClientRect()
		return { x: b.left + b.width / 2 - r.left, y: b.top + b.height / 2 - r.top }
	}
	const lines: [Any, Any, string][] = []
	for (const c of cables) {
		const a = at(c.from), b = at(c.to)
		if (a && b) lines.push([a, b, c.color])
	}
	if (held) {
		const hand = { x: held.x - r.left, y: held.y - r.top }
		const a = held.from ? at(held.from) : hand, b = held.from ? hand : at(held.to)
		if (a && b) lines.push([a, b, held.color])
	}
	g.lineCap = "round"
	for (const [a, b, color] of lines) {
		const dx = b.x - a.x, d = Math.hypot(dx, b.y - a.y)
		const sag = Math.min(110, 18 + d * 0.22)
		g.beginPath()
		g.moveTo(a.x, a.y)
		g.bezierCurveTo(a.x + dx * 0.2, a.y + sag, b.x - dx * 0.2, b.y + sag, b.x, b.y)
		g.shadowColor = "#66003340"
		g.shadowBlur = 8
		g.shadowOffsetY = 4
		g.strokeStyle = "#000"
		g.lineWidth = 7
		g.globalAlpha = 0.9
		g.stroke()
		g.shadowColor = "transparent"
		g.strokeStyle = color
		g.lineWidth = 5
		g.stroke()
		g.globalAlpha = 1
	}
	for (const [a, b, color] of lines) {
		for (const p of [a, b]) {
			g.beginPath()
			g.arc(p.x, p.y, 7.5, 0, 7)
			g.fillStyle = color
			g.fill()
			g.lineWidth = 1
			g.strokeStyle = "#000"
			g.stroke()
			g.beginPath()
			g.arc(p.x, p.y, 2.5, 0, 7)
			g.fillStyle = "#000"
			g.fill()
		}
	}
}

// ---- the look: lemon page, black lines, white cards with a pink glow, cherry, mint, blue ----
const LOOK = `
@import url("https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap");
@keyframes beat { to { opacity: 0 } }
.beat { position: fixed; width: 0; height: 0; pointer-events: none; animation: beat 20ms linear infinite }
* { box-sizing: border-box }
body { background: #ffff88; margin: 10px; font-family: Jost, system-ui, sans-serif; color: #000 }
.world { position: relative; width: max-content; display: flex; flex-direction: column; gap: 10px; padding-bottom: 30px }
.case { background: #fff; border: 1px solid #000; border-radius: 6px; box-shadow: 0 0 10px 2px #66003322;
	padding: 6px 8px; display: flex; flex-direction: column; gap: 6px }
.row { display: flex; gap: 2px; padding: 12px 2px; position: relative; min-height: 296px }
.row::before, .row::after { content: ""; position: absolute; left: 0; right: 0; height: 8px; border: 1px solid #000;
	background: radial-gradient(circle, #000 1.4px, transparent 2px) 0 50% / 15px 8px repeat-x, #ffff88 }
.row::before { top: 0 } .row::after { bottom: 0 }
.module { height: 272px; border: 1px solid #000; border-radius: 2px; padding: 8px 3px 6px; display: flex;
	flex-direction: column; gap: 6px; position: relative; box-shadow: 1px 1px 0 #000; user-select: none }
.module::before, .module::after { content: ""; position: absolute; width: 7px; height: 7px; border-radius: 50%;
	border: 1px solid #000; background: linear-gradient(45deg, #fff 42%, #000 42% 58%, #fff 58%) }
.module::before { top: 3px; left: 3px } .module::after { bottom: 3px; right: 3px }
.module header { display: flex; flex-direction: column; align-items: center }
.module header small { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; margin-top: 2px }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg);
	font-weight: 600; font-size: 13px; line-height: 1.4 }
.knobs { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 0 }
.knob { display: flex; flex-direction: column; align-items: center; width: 46px }
.dial { width: 34px; height: 34px; border-radius: 50%; background: #fff; border: 1px solid #000; position: relative;
	box-shadow: 0 0 8px 1px #ff228433, 1px 1px 0 #000; cursor: ns-resize; touch-action: none;
	transition: transform 100ms, box-shadow 100ms }
.dial:hover { transform: translateY(-1px); box-shadow: 0 0 10px 3px #ff228455, 2px 2px 0 #000 }
.cap { position: absolute; inset: 2px; border-radius: 50%; pointer-events: none }
.cap::after { content: ""; position: absolute; left: 50%; top: 0; width: 4px; height: 12px; margin-left: -2px;
	background: #ff2284; border: 1px solid #000; border-radius: 2px }
.val { font: 600 10px/1.2 ui-monospace, Menlo, monospace }
.label { font-size: 10px; line-height: 1.1 }
.flip { width: 34px; height: 26px; padding: 0; font-size: 15px; font-weight: 600 }
.face { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10px }
.face.leds, .face.side { flex-direction: row; justify-content: center; gap: 7px }
.face.side canvas.shape { width: 82% }
.led.big { width: 16px; height: 16px; margin-top: 6px }
.jacks { margin-top: auto; display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 1px }
.jack { display: flex; flex-direction: column; align-items: center; width: 28px; padding: 3px 0 1px; cursor: grab;
	touch-action: none; font-size: 9.5px; line-height: 1.2; border: 1px solid transparent; border-radius: 2px }
.jack.out { background: #ff2284; border-color: #000; color: #fff; font-weight: 600 }
.jack:active { cursor: grabbing }
.hole { width: 20px; height: 20px; border-radius: 50%; background: #000; border: 1px solid #000;
	box-shadow: inset 0 0 0 3px #ffff88, inset 0 0 0 4px #000 }
.jack.gate .hole { box-shadow: inset 0 0 0 3px #2269ff, inset 0 0 0 4px #000 }
.jack:hover .hole { outline: 2px solid #40dcba; outline-offset: 1px }
.led { width: 10px; height: 10px; border-radius: 50%; border: 1px solid #000; background: #fff; display: inline-block }
.led[data-on] { background: #40dcba; box-shadow: 0 0 8px #40dcba }
.led[data-flash=a] { animation: flash-a .22s ease-out } .led[data-flash=b] { animation: flash-b .22s ease-out }
@keyframes flash-a { from { background: #ff2284; box-shadow: 0 0 14px #ff2284 } }
@keyframes flash-b { from { background: #ff2284; box-shadow: 0 0 14px #ff2284 } }
.led.breathe { width: 14px; height: 14px; animation: breathe 3s ease-in-out infinite alternate }
@keyframes breathe { to { background: #40dcba; box-shadow: 0 0 12px 2px #40dcba } }
.screen { border: 1px solid #000; border-radius: 2px; background: #fff; box-shadow: inset 0 0 10px #ff228422 }
.face canvas.screen { width: 100%; height: auto }
.face canvas.shape { width: 100%; height: auto }
.face canvas.meter { width: 24px; height: 80px; border: 0; box-shadow: none; background: transparent }
.power { width: 42px; height: 42px; border-radius: 50%; font-size: 20px; padding: 0 }
.power[data-on] { background: #40dcba; box-shadow: 0 0 12px #40dcba, 1px 1px 0 #000 }
canvas.wires { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5 }
.card { background: #fff; border: 1px solid #000; border-radius: 6px; box-shadow: 0 0 10px 2px #66003322; padding: 8px 10px }
.cables header { display: flex; align-items: center; gap: 10px; font-size: 11px }
.cables header small { flex: 1 }
.cables ul { columns: 3; list-style: none; padding: 0; margin: 8px 0 0; font-size: 12px }
.cables li { break-inside: avoid; display: flex; align-items: center; gap: 4px; margin: 2px 0 }
.cables code { font: 11px ui-monospace, Menlo, monospace }
.swatch { display: inline-block; width: 11px; height: 11px; border: 1px solid #000; border-radius: 50% }
button { font: inherit; padding: 2px 10px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 1px 1px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translateY(-1px); box-shadow: 2px 2px 0 #000 }
button:active { transform: none; box-shadow: none }
button.x { padding: 0 5px; line-height: 1.1; margin-left: auto }
`
