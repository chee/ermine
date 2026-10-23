/// <reference lib="dom" />
// little sounds, made here (no files): a blip for a press, a snap for a wire, a chime for a den
// arriving, a ding-dong for a pair ask, a run up for a pairing. quiet; nothing until the first
// gesture; muted is remembered. and the voices a sound thing and a den's speaker play (VOICES):
// soft and round, sine and triangle, a little FM for the bell and glass ones, soft attacks, short
// tails, a touch of echo. sound.play(name) says whether it was heard: "played", "muted", or
// "waiting" (no click on the page yet: browsers keep a page quiet until one)
const KEY = "dens.muted"
let ctx: AudioContext | undefined
let muted = localStorage.getItem(KEY) === "1"

// the first gesture starts the sound; every real button is a key, clicking as it goes down
addEventListener("pointerdown", (e) => {
	ctx ??= new AudioContext()
	if (ctx.state === "suspended") ctx.resume()
	const b = (e.target as HTMLElement).closest?.("button")
	if (b && !b.disabled) sound.key()
}, { capture: true })

// a physical key: a short sharp tick of noise, and a tiny low thunk under it
function key() {
	if (!ctx || muted) return
	const t = ctx.currentTime
	const n = Math.floor(ctx.sampleRate * 0.018)
	const buf = ctx.createBuffer(1, n, ctx.sampleRate)
	const d = buf.getChannelData(0)
	for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3
	const src = ctx.createBufferSource()
	src.buffer = buf
	const hp = ctx.createBiquadFilter()
	hp.type = "bandpass"
	hp.frequency.value = 3800
	hp.Q.value = 0.8
	const g = ctx.createGain()
	g.gain.value = 0.22
	src.connect(hp).connect(g).connect(ctx.destination)
	src.start(t)
	const o = ctx.createOscillator(), og = ctx.createGain()
	o.type = "sine"
	o.frequency.setValueAtTime(150, t)
	o.frequency.exponentialRampToValueAtTime(55, t + 0.05)
	og.gain.setValueAtTime(0.0001, t)
	og.gain.linearRampToValueAtTime(0.09, t + 0.003)
	og.gain.exponentialRampToValueAtTime(0.0001, t + 0.055)
	o.connect(og).connect(ctx.destination)
	o.start(t)
	o.stop(t + 0.07)
}

function tone(freq: number, at: number, len: number, gain = 0.05, type: OscillatorType = "square") {
	if (!ctx || muted) return
	const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter()
	f.type = "lowpass"
	f.frequency.value = 3200
	o.type = type
	o.frequency.value = freq
	const t = ctx.currentTime + at
	g.gain.setValueAtTime(0, t)
	g.gain.linearRampToValueAtTime(gain, t + 0.004)
	g.gain.exponentialRampToValueAtTime(0.0001, t + len)
	o.connect(f).connect(g).connect(ctx.destination)
	o.start(t)
	o.stop(t + len + 0.02)
}

// ---- the voices ----
export const VOICES = ["ding", "pop", "sparkle", "plink", "blip", "tick", "chime"] as const
export type Voice = typeof VOICES[number]
export const isVoice = (v: unknown): v is Voice => VOICES.includes(v as Voice)

// where every voice goes: straight out, and a little through a soft echo (made once)
let bus: AudioNode | undefined
function out(c: AudioContext): AudioNode {
	if (bus) return bus
	const into = c.createGain(), echo = c.createDelay(1), back = c.createGain()
	const wet = c.createGain(), soft = c.createBiquadFilter()
	into.gain.value = 0.9
	echo.delayTime.value = 0.14
	back.gain.value = 0.28
	wet.gain.value = 0.22
	soft.type = "lowpass"
	soft.frequency.value = 2600
	into.connect(c.destination)
	into.connect(echo)
	echo.connect(soft).connect(back).connect(echo)
	soft.connect(wet).connect(c.destination)
	return bus = into
}
// a soft swell up and a gentle fall: attack s, then down to nothing over tail s
function swell(c: AudioContext, at: number, peak: number, attack: number, tail: number) {
	const g = c.createGain()
	g.gain.setValueAtTime(0, at)
	g.gain.linearRampToValueAtTime(peak, at + attack)
	g.gain.exponentialRampToValueAtTime(0.0001, at + attack + tail)
	return g
}
// one round note: a sine (or triangle), a little FM on it (ratio, depth falling away), soft
function note(
	c: AudioContext,
	f: number,
	at: number,
	o: {
		peak?: number
		attack?: number
		tail?: number
		ratio?: number
		depth?: number
		wave?: OscillatorType
	} = {},
) {
	const { peak = 0.06, attack = 0.006, tail = 0.45, ratio = 0, depth = 0, wave = "sine" } = o
	const osc = c.createOscillator(), g = swell(c, at, peak, attack, tail)
	osc.type = wave
	osc.frequency.setValueAtTime(f, at)
	if (ratio > 0 && depth > 0) {
		const mod = c.createOscillator(), md = c.createGain()
		mod.frequency.value = f * ratio
		md.gain.setValueAtTime(f * depth, at)
		md.gain.exponentialRampToValueAtTime(1, at + attack + tail * 0.6)
		mod.connect(md).connect(osc.frequency)
		mod.start(at)
		mod.stop(at + attack + tail + 0.05)
	}
	osc.connect(g).connect(out(c))
	osc.start(at)
	osc.stop(at + attack + tail + 0.05)
	return osc
}
const VOICE: Record<Voice, (c: AudioContext, t: number) => void> = {
	// a glassy ding: a bell's FM, high and clear, ringing out
	ding: (c, t) => note(c, 1568, t, { ratio: 3.5, depth: 1.2, tail: 0.9, peak: 0.05 }),
	// a soft bubble pop: a round note sliding quickly up
	pop: (c, t) => {
		const o = note(c, 320, t, { tail: 0.12, peak: 0.08, attack: 0.004 })
		o.frequency.exponentialRampToValueAtTime(980, t + 0.07)
	},
	// a sparkly little run up: four glassy notes
	sparkle: (c, t) =>
		[1046.5, 1318.5, 1568, 2093].forEach((f, i) =>
			note(c, f, t + i * 0.06, { ratio: 2, depth: 0.5, tail: 0.32, peak: 0.035 })
		),
	// a marimba plink: a wooden bar, its fourth partial over it, quick to fade
	plink: (c, t) => {
		note(c, 784, t, { tail: 0.35, peak: 0.07, attack: 0.003 })
		note(c, 784 * 4, t, { tail: 0.06, peak: 0.02, attack: 0.002 })
	},
	// a cosy chat-room blip: two soft triangle steps up
	blip: (c, t) => {
		note(c, 880, t, { wave: "triangle", tail: 0.09, peak: 0.06 })
		note(c, 1174.7, t + 0.06, { wave: "triangle", tail: 0.14, peak: 0.06 })
	},
	// a wooden tick: a short knock, high and dry
	tick: (c, t) => {
		note(c, 1900, t, { tail: 0.035, peak: 0.08, attack: 0.001, ratio: 1.41, depth: 0.8 })
		note(c, 420, t, { tail: 0.05, peak: 0.05, attack: 0.001 })
	},
	// a happy two-note chime: a soft bell, up a fifth
	chime: (c, t) => {
		note(c, 1046.5, t, { ratio: 2, depth: 0.6, tail: 0.5, peak: 0.045 })
		note(c, 1568, t + 0.13, { ratio: 2, depth: 0.6, tail: 0.7, peak: 0.045 })
	},
}

export const sound = {
	key,
	blip: () => tone(1760, 0, 0.03, 0.035),
	snap: () => (tone(660, 0, 0.03, 0.04), tone(1320, 0.035, 0.05, 0.035)),
	chime: () => (tone(880, 0, 0.18, 0.03, "sine"), tone(1318.5, 0.12, 0.28, 0.03, "sine")),
	// a soft note (a sound thing's)
	note: (freq: number) => (tone(freq, 0, 0.22, 0.04, "triangle"), tone(freq * 2, 0, 0.06, 0.012)),
	no: () => tone(220, 0, 0.12, 0.04, "triangle"),
	// someone asking to pair: a soft ding-dong
	ask: () => (tone(1046.5, 0, 0.16, 0.025, "sine"), tone(784, 0.14, 0.26, 0.025, "sine")),
	// paired: a happy little run up
	yay: () =>
		[523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(f, i * 0.07, 0.14, 0.03, "triangle")),
	// a voice, if it can be heard now
	play(name: Voice): "played" | "muted" | "waiting" {
		if (muted) return "muted"
		if (!ctx || ctx.state !== "running") return "waiting"
		VOICE[name](ctx, ctx.currentTime + 0.01)
		return "played"
	},
	get muted() {
		return muted
	},
	toggle() {
		muted = !muted
		localStorage.setItem(KEY, muted ? "1" : "0")
		return muted
	},
}
