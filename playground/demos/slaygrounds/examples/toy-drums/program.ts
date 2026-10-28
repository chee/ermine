/** @jsxImportSource @ermine */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	createWriter,
	ensureNode,
	executeAction,
	patch,
	peep,
	read,
	ref,
} from "@ermine/system"
import { bind, handler } from "@ermine/render/h"

// toy-drums: three drums, eight steps. the pattern is one node (three strings, x = hit), the
// playhead is another. the grid and the little text pattern under it are two views of those nodes.
// change a drum sound or a label below and save: the beat keeps going, the pattern stays. each
// cell is bound to the pattern; the playhead is one bar over the grid, bound to its own node.
// the beat keeps itself: ▶ plays, and a timer made in setup (its own writer) moves the playhead a
// step every 170ms while playing; the step button moves it one place by hand
const drums = ["kick", "snare", "hat"]
const css = `
.drums{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:14px;max-width:420px;margin:0 auto;font-family:Jost,system-ui,sans-serif}
.drums .grid{display:grid;grid-template-columns:48px repeat(8,1fr);gap:4px;align-items:center}
.drums .grid span{font-size:13px}
.drums .grid b{height:34px;border:1px solid #000;border-radius:2px;background:#fffdf0;cursor:pointer;box-shadow:1px 1px 0 #000}
.drums .grid b.hit{background:#ff2284}
.drums .grid i.head{grid-row:1/4;align-self:stretch;border:3px solid #2269ff;border-radius:3px;margin:-4px;pointer-events:none}
.drums .row{display:flex;gap:8px;margin:12px 0 6px}
.drums pre{margin:0;font:13px/1.4 ui-monospace,monospace;background:#fffdf0;border:1px dashed #000;padding:6px}
`

export default function program() {
	const pattern = ensureNode("./pattern", ["x...x...", "....x...", "x.x.x.x."])
	const step = ensureNode("./step", 0)
	const playing = ensureNode("./playing", false)
	const rows = () => read(pattern) as string[]
	const at = () => read(step) as number
	const now = <T,>(x: unknown) => peep(() => read(x as never)) as T
	const put = (x: unknown, value: unknown) => patch(x as never, [{ path: [], value }])

	// the same pattern, as text, with a playhead
	createMemo("ascii", () => {
		const s = at()
		const lines = rows().map((r, i) => drums[i].padEnd(6) + r)
		return lines.join("\n") + "\n" + " ".repeat(6 + s) + "^"
	})
	// where the playhead is: the step while playing, none when stopped
	createMemo("playhead", () => (read(playing) ? at() : -1))

	// a toggle changes one row of the pattern
	createAction("on/toggle", (row: number, col: number) => {
		const r = now<string[]>(pattern)[row]
		patch(pattern, [{
			path: [row],
			value: r.slice(0, col) + (r[col] === "x" ? "." : "x") + r.slice(col + 1),
		}])
	})
	createAction("on/play", () => put(playing, !now<boolean>(playing)))
	createAction("on/clear", () => put(pattern, drums.map(() => "........")))
	createAction("on/surprise", () => {
		const r = (p: number) =>
			Array.from({ length: 8 }, () => Math.random() < p ? "x" : ".").join("")
		put(pattern, [r(0.3), r(0.2), r(0.6)])
	})
	// the playhead moves one step (and plays the step's sounds): by the timer while playing, or by a press
	createAction("on/step", () => put(step, (now<number>(step) + 1) % 8))
	const withWriter = createWriter()
	const timer = setInterval(
		() => withWriter(() => now<boolean>(playing) && executeAction("on/step")),
		170,
	)
	addTeardown(() => clearInterval(timer))

	// the sounds: a tiny synth, made on first press (a browser wants a click before it speaks)
	// a live thing, so a ref: it is there till the process stops
	const audio = read(ref("audio", () => ({}))) as { ctx?: AudioContext }
	const noise = (ctx, len) => {
		const b = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate)
		b.getChannelData(0).forEach((_, i, d) => (d[i] = Math.random() * 2 - 1))
		return b
	}
	const hit = (kind) => {
		const ctx = audio.ctx
		if (!ctx) return
		const now = ctx.currentTime, g = ctx.createGain()
		g.connect(ctx.destination)
		if (kind === "kick") {
			const o = ctx.createOscillator()
			o.frequency.setValueAtTime(150, now)
			o.frequency.exponentialRampToValueAtTime(40, now + 0.15)
			g.gain.setValueAtTime(0.8, now)
			g.gain.exponentialRampToValueAtTime(0.001, now + 0.2)
			o.connect(g), o.start(now), o.stop(now + 0.2)
		} else {
			const n = ctx.createBufferSource(), f = ctx.createBiquadFilter()
			n.buffer = noise(ctx, 0.2)
			f.type = "highpass"
			f.frequency.value = kind === "hat" ? 7000 : 1500
			g.gain.setValueAtTime(kind === "hat" ? 0.25 : 0.5, now)
			g.gain.exponentialRampToValueAtTime(0.001, now + (kind === "hat" ? 0.05 : 0.15))
			n.connect(f), f.connect(g), n.start(now)
		}
	}
	// a hit per step: an effect over the step, the pattern and the play flag
	createEffect(
		"sound",
		() => ({ s: at(), p: rows(), on: read(playing) as boolean }),
		(v, before) => {
			if (v.on && before && before.s !== v.s) {
				v.p.forEach((r, i) => r[v.s] === "x" && hit(drums[i]))
			}
		},
	)
	// the press that plays: the synth made (the browser wants a person's click for it), no
	// arguments for the call
	const wake = () => {
		audio.ctx ??= new AudioContext()
		audio.ctx.resume()
		return []
	}

	// each cell placed in its row and column (so the playhead can lie over them), its colour bound
	// to its letter in the pattern
	const cell = (r: number, i: number) => (
		<b
			style={`grid-row:${r + 1};grid-column:${i + 2}`}
			class={bind("./pattern", (p: string[]) => (p[r][i] === "x" ? "hit" : ""))}
			onClick={handler("on/toggle", [r, i])}
		/>
	)
	return (
		<div class="drums">
			<style>{css}</style>
			<div class="grid">
				{drums.map((d, r) => [
					<span style={`grid-row:${r + 1};grid-column:1`}>{d}</span>,
					...Array.from({ length: 8 }, (_, i) => cell(r, i)),
				])}
				<i
					class="head"
					style={bind(
						"playhead",
						(s: number) => (s < 0 ? "display:none" : `grid-column:${s + 2}`),
					)}
				/>
			</div>
			<div class="row">
				<button onClick={handler("on/play", wake)}>
					{bind("./playing", (p) => (p ? "⏸ stop" : "▶ play"))}
				</button>
				<button onClick={handler("on/step", wake)}>⏭ step</button>
				<button onClick={handler("on/clear")}>🧽 clear</button>
				<button onClick={handler("on/surprise")}>🎲 surprise</button>
			</div>
			<pre>{bind("ascii")}</pre>
			<small>
				the playhead moves a step six times a second while playing, or when you press ⏭
			</small>
		</div>
	)
}
