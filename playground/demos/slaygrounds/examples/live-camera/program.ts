/** @jsxImportSource ermine-h */
import type { API, Node } from "@ermine/api"
import { bind, type Child, handler } from "ermine-h"

// live-camera: three processes on a board, wired by the addresses in their `in` nodes.
//   source    holds a live MediaStream in a node and writes its `frame` (an ImageData) every frame
//   transform has an editor; its text is a node, its compiled function a memo, its `out` the result
//   output    draws /transform/out
// what a person edits is saved under ./board (a code text, a wire, a card's place, the rate, the
// stream): a reload finds it. edit the transform's code in the card (or a preset): no restart. edit
// this file: a reload, the editor text and the camera are kept. the editor is the host's (extend)
type Cam = API & {
	editor: (
		parent: HTMLElement,
		doc: string,
		onchange: (text: string) => void,
	) => { destroy(): void }
	settext: (view: unknown, text: string) => void
}
const W = 160, H = 120
// where the cards first sit
const start: Record<string, number[]> = { source: [8, 70], transform: [208, 20], output: [494, 70] }

const css = document.createElement("style")
css.textContent =
	`.card.source{width:176px}.card.transform{width:262px;height:440px}.card.output{width:176px}
.card.source canvas,.card.output canvas{width:100%;aspect-ratio:4/3}
.card.transform .cm-host{min-height:230px}`
document.head.append(css)

// a card's common nodes: where it sits (the board writes it, through on/move), and one line of numbers
function common({ open, edit, method }: API, name: string) {
	const pos = open(`./board/${name}/pos`, start[name])
	method("on/move", (xy: number[]) => edit(pos, [{ path: [], value: xy }]))
	return { fps: open("fps", 0), cost: open("cost", "") }
}
// once a second: how many frames this stage handled and what its own work cost (a write per number)
function every(
	{ edit, teardown }: API,
	nodes: { fps: Node; cost: Node },
	stats: { n: number; line: () => string },
) {
	let last = performance.now()
	const timer = setInterval(() => {
		const now = performance.now()
		const n = Math.round(stats.n * 1000 / (now - last))
		const text = stats.line() // reads n, so before it is zeroed
		stats.n = 0
		last = now
		edit(nodes.fps, () => n)
		edit(nodes.cost, () => text)
	}, 1000)
	teardown(() => clearInterval(timer))
}
// a stage's line of numbers, bound to its own fps and cost
const Stat = () => (
	<div class="stat">
		{bind("fps")} fps · {bind("cost")}
	</div>
)
// a stage's view: no box of its own, the card's body lays it out
const Stage = (props: { children?: Child }) => <div style="display: contents">{props.children}</div>
const ms = (x: number) => x.toFixed(2) + "ms"

// ---- source: a camera, or a test pattern ----
export function source(api: API) {
	const { open, read, edit, effect, method, ref, teardown } = api
	const frame = open("frame", null)
	// the live value: a MediaStream, in memory only (a ref, kept across reloads: a stop is "ended")
	const stream = ref("./board/source/stream", () => null)
	const mode = open("mode", "test pattern: waiting for the camera…")
	const rate = open("./board/source/rate", 30) // 30 | 60 | 0 (as fast as it can go)
	const nodes = common(api, "source")
	const grab = Object.assign(document.createElement("canvas"), { width: W, height: H })
	const video = Object.assign(document.createElement("video"), { muted: true, playsInline: true })
	const ctx = grab.getContext("2d", { willReadFrequently: true })!
	const stats = { n: 0, grab: 0, write: 0, round: 0, frames: 0, line: () => "" }
	stats.line = () => {
		const k = Math.max(1, stats.frames)
		const s = `grab ${ms(stats.grab / k)} · write ${ms(stats.write / k)} · whole chain ${
			ms(stats.round / k)
		}`
		stats.grab =
			stats.write =
			stats.round =
			stats.frames =
				0
		return s
	}
	const say = (how: string) => edit(mode, () => how)
	method("on/rate", (r: number) => edit(rate, () => r))

	// the live value is attached by an effect: when the node holds a stream the video plays it
	effect("attach", () => read(stream) as MediaStream | null, (ms) => {
		if (ms && video.srcObject !== ms) (video.srcObject = ms, video.play().catch(() => {}))
	})

	let alive = true
	// the stream arrives from outside the scheduler (a promise): it writes as the process
	const arrived = (ms: MediaStream) => {
		if (!alive) return ms.getTracks().forEach((x) => x.stop())
		live = ms
		edit(stream, [{ path: [], value: ms }])
		say("camera: a live MediaStream is in ./board/source/stream")
	}
	let live = read(stream) as MediaStream | null | undefined
	if (live && !live.active) live = undefined
	if (!live) {
		navigator.mediaDevices?.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
			.then(arrived)
			.catch((e) => alive && say(`test pattern: no camera (${e?.name ?? "unavailable"})`))
		if (!navigator.mediaDevices) say("test pattern: no camera (no mediaDevices)")
	} else {
		say("camera: a live MediaStream is in ./board/source/stream")
		video.play().catch(() => {})
	}

	function draw(k: number) {
		if (live && video.readyState >= 2) {
			ctx.drawImage(video, 0, 0, W, H)
			return
		}
		// the test pattern: colour bars sliding, a bouncing ring, a counter
		for (let i = 0; i < 8; i++) {
			ctx.fillStyle = `hsl(${(i * 45 + k * 2) % 360} 80% 60%)`
			ctx.fillRect(i * W / 8, 0, W / 8 + 1, H)
		}
		ctx.fillStyle = "#000a"
		ctx.fillRect(0, H * 0.62, W, H * 0.38)
		ctx.strokeStyle = "#fff"
		ctx.lineWidth = 6
		ctx.beginPath()
		ctx.arc(W / 2 + Math.sin(k / 12) * 50, H * 0.35 + Math.abs(Math.sin(k / 17)) * 20, 22, 0, 7)
		ctx.stroke()
		ctx.fillStyle = "#fff"
		ctx.font = "bold 14px sans-serif"
		ctx.fillText("test pattern", 8, H * 0.8)
		ctx.fillText("frame " + k, 8, H * 0.93)
	}

	// the frame loop writes the frame node itself, as the process: no method in between
	let k = 0, last = 0, raf = 0
	const channel = new MessageChannel()
	function tick(now: number) {
		if (!alive) return
		const r = read(rate) as number
		if (r === 30 && now - last < 30) return next()
		last = now
		const a = performance.now()
		draw(k++)
		const img = ctx.getImageData(0, 0, W, H)
		const b = performance.now()
		stats.n++
		stats.frames++
		edit(frame, [{ path: [], value: img }])
		stats.write += performance.now() - b
		stats.grab += b - a
		stats.round += performance.now() - b
		next()
	}
	function next() {
		const r = read(rate) as number
		if (r === 0) channel.port2.postMessage(0)
		else raf = requestAnimationFrame(tick)
	}
	channel.port1.onmessage = () => tick(performance.now())
	next()
	teardown((why) => {
		alive = false
		cancelAnimationFrame(raf)
		// a reload keeps the camera; the process ending lets it go
		if (why === "ended") {
			;(read(stream) as MediaStream | null)?.getTracks().forEach((x) => x.stop())
		}
	})
	every(api, nodes, stats)

	// the cap goes 30 → 60 → none → 30
	const nextRate = () => [{ 30: 60, 60: 0, 0: 30 }[read(rate) as number]]
	// asking again is the browser's: a promise, so a plain listener
	const ask = () => navigator.mediaDevices?.getUserMedia({ video: true }).then(arrived)
	return (
		<Stage>
			{grab}
			<p class="note">{bind("mode")}</p>
			<Stat />
			<div class="row">
				<button onClick={handler("on/rate", nextRate)}>
					{bind("board/source/rate", (r) => (r ? `${r} fps cap` : "no cap"))}
				</button>
				<button onClick={ask}>ask for camera</button>
			</div>
		</Stage>
	)
}

// ---- transform: an editor over a function over ImageData ----
const presets: Record<string, string> = {
	invert: `// frame: ImageData in (never change it), ImageData out
function transform(frame) {
  const out = new ImageData(frame.width, frame.height)
  const a = frame.data, b = out.data
  for (let i = 0; i < a.length; i += 4) {
    b[i] = 255 - a[i]
    b[i + 1] = 255 - a[i + 1]
    b[i + 2] = 255 - a[i + 2]
    b[i + 3] = 255
  }
  return out
}
`,
	gray: `function transform(frame) {
  const out = new ImageData(frame.width, frame.height)
  const a = frame.data, b = out.data
  for (let i = 0; i < a.length; i += 4) {
    const g = a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11
    b[i] = b[i + 1] = b[i + 2] = g
    b[i + 3] = 255
  }
  return out
}
`,
	edges: `// sobel edge detection on the brightness
function transform(frame) {
  const { width: w, height: h, data: a } = frame
  const out = new ImageData(w, h)
  const b = out.data
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) lum[i] = a[i * 4] * 0.3 + a[i * 4 + 1] * 0.59 + a[i * 4 + 2] * 0.11
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1]
      const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1]
      const m = Math.min(255, Math.hypot(gx, gy))
      b[i * 4] = m
      b[i * 4 + 1] = m * 0.2
      b[i * 4 + 2] = m * 0.65
      b[i * 4 + 3] = 255
    }
  }
  return out
}
`,
	threshold: `function transform(frame) {
  const out = new ImageData(frame.width, frame.height)
  const a = frame.data, b = out.data
  for (let i = 0; i < a.length; i += 4) {
    const on = a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11 > 110
    b[i] = on ? 255 : 255; b[i + 1] = on ? 247 : 34; b[i + 2] = on ? 168 : 132
    b[i + 3] = 255
  }
  return out
}
`,
	mirror: `function transform(frame) {
  const { width: w, height: h, data: a } = frame
  const out = new ImageData(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + (w - 1 - x)) * 4, d = (y * w + x) * 4
      out.data.set(a.subarray(s, s + 4), d)
    }
  return out
}
`,
}
// the text is compiled into a function; one that throws on a trial frame is an error, not a function
function compile(text: string) {
	try {
		const fn = new Function(text + "\nreturn transform")()
		const test = fn(new ImageData(4, 4))
		if (!test || !test.data) throw new Error("transform must return an ImageData")
		return { fn }
	} catch (e) {
		return { error: String(e?.message ?? e) }
	}
}

export function transform(api: Cam) {
	const { open, read, edit, memo, method, teardown, editor: makeEditor, settext } = api
	const inn = open("./board/transform/in", "/source/frame") // the address it reads: the board draws the wire from it
	const code = open("./board/transform/code", presets.invert) // the editor's text, a node
	const nodes = common(api, "transform")
	const stats = { n: 0, work: 0, line: () => "" }
	stats.line = () => {
		const s = `fn ${ms(stats.work / Math.max(1, stats.n))}`
		stats.work = 0
		return s
	}
	// the function, recompiled when the text changes: nothing else restarts
	const fn = memo("fn", () => compile(read(code) as string))
	memo("status", () => (read(fn) as any).error ?? "ok")
	let lastError = ""
	method("on/edit", (text: string) => edit(code, () => text))
	// out: reads the input address, runs the function. the result is a node
	memo("out", () => {
		const f = read(fn) as any
		const img = read(String(read(inn))) as ImageData | null | undefined
		if (!img || !img.data || f.error) return img
		const a = performance.now()
		try {
			const r = f.fn(img)
			stats.n++
			stats.work += performance.now() - a
			if (lastError) lastError = ""
			return r
		} catch (e) {
			lastError = String((e as Error)?.message ?? e)
			return img
		}
	})

	every(api, nodes, stats)
	// the editor is the host's (CodeMirror): a div it draws in, placed and never touched
	const host = Object.assign(document.createElement("div"), { className: "cm-host" })
	let timer: number
	// typing is debounced into one write; a preset button writes the text into the editor, same path
	const editor = makeEditor(host, read(code) as string, (text) => {
		clearTimeout(timer)
		timer = setTimeout(() => api.send("on/edit", text), 120)
	})
	teardown(() => (clearTimeout(timer), editor.destroy()))
	return (
		<Stage>
			<div class="row">
				{Object.entries(presets).map(([name, text]) => (
					<button onClick={() => settext(editor, text)}>{name}</button>
				))}
			</div>
			{host}
			<p class="note warn">{bind("status")}</p>
			<Stat />
		</Stage>
	)
}
// ---- output ----
export function output(api: API) {
	const { open, read, effect } = api
	const inn = open("./board/output/in", "/transform/out")
	const nodes = common(api, "output")
	const stats = { n: 0, draw: 0, line: () => "" }
	stats.line = () => {
		const s = `draw ${ms(stats.draw / Math.max(1, stats.n))}`
		stats.draw = 0
		return s
	}
	const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H })
	const ctx = canvas.getContext("2d")!
	// an effect: reads the address it is wired to, draws each new frame
	effect("draw", () => read(String(read(inn))) as ImageData | null | undefined, (img) => {
		if (!img?.data) return
		const a = performance.now()
		ctx.putImageData(img, 0, 0)
		stats.draw += performance.now() - a
		stats.n++
	})
	every(api, nodes, stats)
	return (
		<Stage>
			{canvas}
			<Stat />
		</Stage>
	)
}
