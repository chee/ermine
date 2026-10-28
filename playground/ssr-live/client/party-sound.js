// the party's beat, played on this page only. LLM generated: a prototype. off till its button is
// pressed (a page may not make a sound before a click); then, each time the server's playhead
// lands on a step (its dot's class changes: "ermine:change"), the steps on in that column play
let audio
const button = document.getElementById("sound")
button.addEventListener("click", () => {
	audio = audio ? void audio.close() : new AudioContext()
	button.textContent = audio ? "sound: on" : "sound: off"
})
addEventListener("ermine:change", (e) => {
	if (!audio || !e.target.classList.contains("now")) return
	const step = e.target.dataset.step
	for (const on of document.querySelectorAll(`.step.on[data-step="${step}"]`)) {
		play(on.dataset.sound)
	}
})

function play(sound) {
	const t = audio.currentTime
	const gain = audio.createGain()
	gain.connect(audio.destination)
	const fade = (from, length) => {
		gain.gain.setValueAtTime(from, t)
		gain.gain.exponentialRampToValueAtTime(0.001, t + length)
	}
	if (sound == "kick" || sound == "blip") {
		const o = audio.createOscillator()
		if (sound == "kick") {
			o.frequency.setValueAtTime(150, t)
			o.frequency.exponentialRampToValueAtTime(40, t + 0.15)
			fade(0.9, 0.2)
		} else {
			o.type = "triangle"
			o.frequency.value = 880
			fade(0.25, 0.12)
		}
		o.connect(gain)
		o.start(t)
		return o.stop(t + 0.2)
	}
	// snare and hat: a burst of noise, filtered
	const length = sound == "hat" ? 0.05 : 0.15
	const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * length), audio.sampleRate)
	const data = buffer.getChannelData(0)
	for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
	const noise = audio.createBufferSource()
	const filter = audio.createBiquadFilter()
	noise.buffer = buffer
	filter.type = sound == "hat" ? "highpass" : "bandpass"
	filter.frequency.value = sound == "hat" ? 7000 : 1800
	fade(sound == "hat" ? 0.3 : 0.6, length)
	noise.connect(filter).connect(gain)
	noise.start(t)
	noise.stop(t + length)
}
