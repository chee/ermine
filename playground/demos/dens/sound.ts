/// <reference lib="dom" />
// little sounds, made here (no files): a blip for a press, a snap for a wire, a chime for a den
// arriving, a ding-dong for a pair ask, a run up for a pairing. quiet; nothing until the first
// gesture; muted is remembered
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
	get muted() {
		return muted
	},
	toggle() {
		muted = !muted
		localStorage.setItem(KEY, muted ? "1" : "0")
		return muted
	},
}
