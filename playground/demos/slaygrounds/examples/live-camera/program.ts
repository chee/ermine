/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	patch,
	peep,
	PENDING,
	read,
	ref,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, type Child, handler } from "ermine-h"

// live-camera: three processes on a board, wired by the addresses in their `in` nodes.
//   source    holds a live MediaStream in a node and writes its `frame` (an ImageData) every frame
//   transform has an editor; its text is a node, its compiled function a memo, its `out` the result
//   output    draws /transform/out
// what a person edits is saved under ./board (a code text, a wire, a card's place, the rate, the
// stream): a reload finds it. edit the transform's code in the card (or a preset): no restart. edit
// this file: a reload, the editor text and the camera are kept. the editor is the host's (extend)
// nothing is open in a frame callback or a timer, so a program cannot write from one: the host
// (host.ts) keeps the clocks and runs the actions here: on/frame each frame (the source's), on/stats
// each second (every process's), and the editor's typing (the transform's on/edit). the camera's
// promise is a memo's: the memo is pending while it is out, and the stream is its value
type Cam = {
	editor: (parent: HTMLElement, doc: string) => { destroy(): void }
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
function common(name: string) {
	const pos = ensureNode(`./board/${name}/pos`, start[name])
	createAction("on/move", (xy: number[]) => patch(pos, [{ path: [], value: xy }]))
	return { fps: ensureNode("fps", 0), cost: ensureNode("cost", "") }
}
// once a second, run by the host: how many frames this stage handled and what its own work cost (a
// write per number)
function every(
	nodes: { fps: ReturnType<typeof ensureNode>; cost: ReturnType<typeof ensureNode> },
	stats: { n: number; line: () => string },
) {
	let last = performance.now()
	createAction("on/stats", () => {
		const now = performance.now()
		const n = Math.round(stats.n * 1000 / (now - last))
		const text = stats.line() // reads n, so before it is zeroed
		stats.n = 0
		last = now
		patch(nodes.fps, [{ path: [], value: n }])
		patch(nodes.cost, [{ path: [], value: text }])
	})
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
export function source() {
	const frame = ensureNode("frame", null)
	// the live value: a MediaStream, in memory only (a ref, kept across reloads: a stop is "ended")
	const stream = ref("./board/source/stream", () => null)
	const rate = ensureNode("./board/source/rate", 30) // 30 | 60 | 0 (as fast as it can go)
	const asked = ensureNode("asked", 0)
	const nodes = common("source")
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
	// the cap goes 30 → 60 → none → 30
	createAction("on/rate", () => {
		const r = peep(() => read(rate)) as 30 | 60 | 0
		patch(rate, [{ path: [], value: { 30: 60, 60: 0, 0: 30 }[r] }])
	})
	createAction(
		"on/ask",
		() => patch(asked, [{ path: [], value: (peep(() => read(asked)) as number) + 1 }]),
	)

	let alive = true
	// the camera: a stream still live from before a reload is kept; else the browser is asked (and
	// again at each "ask for camera"). a promise: the memo is pending while it is out, and its value
	// is the stream, or why not
	type Camera = MediaStream | { error: string }
	createMemo("camera", (): Camera | Promise<Camera> | typeof PENDING => {
		const n = read(asked) as number
		const had = peep(() => read(stream)) as MediaStream | null
		if (n === 0 && had?.active) return had
		if (!navigator.mediaDevices) return { error: "no mediaDevices" }
		return navigator.mediaDevices.getUserMedia({
			video: { width: 320, height: 240 },
			audio: false,
		})
			.then((got): Camera => {
				if (alive) return got
				got.getTracks().forEach((x) => x.stop())
				return { error: "stopped" }
			})
			.catch((e): Camera => ({ error: e?.name ?? "unavailable" }))
	})
	// what the card says about it
	createMemo("mode", () => {
		let got: unknown
		try {
			got = read("camera")
		} catch (e) {
			if (e === PENDING) return "test pattern: waiting for the camera…"
			throw e
		}
		return got instanceof MediaStream
			? "camera: a live MediaStream is in ./board/source/stream"
			: `test pattern: no camera (${(got as { error: string }).error})`
	})
	// the stream into its node (the node outlives a reload), and from the node into the video
	createEffect("keep", () => read("camera") as Camera, (got) => {
		if (got instanceof MediaStream) patch(stream, [{ path: [], value: got }])
	})
	let current: MediaStream | null = null
	createEffect("attach", () => read(stream) as MediaStream | null, (ms) => {
		current = ms
		if (ms && video.srcObject !== ms) (video.srcObject = ms, video.play().catch(() => {}))
	})

	function draw(k: number) {
		if (current?.active && video.readyState >= 2) {
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

	// one frame, run by the host's frame loop: it writes the frame node itself
	let k = 0
	createAction("on/frame", () => {
		const a = performance.now()
		draw(k++)
		const img = ctx.getImageData(0, 0, W, H)
		const b = performance.now()
		stats.n++
		stats.frames++
		patch(frame, [{ path: [], value: img }])
		stats.write += performance.now() - b
		stats.grab += b - a
		stats.round += performance.now() - b
	})
	addTeardown((why) => {
		alive = false
		// a reload keeps the camera; the process ending lets it go
		if (why === "ended") current?.getTracks().forEach((x) => x.stop())
	})
	every(nodes, stats)

	return (
		<Stage>
			{grab}
			<p class="note">{bind("mode")}</p>
			<Stat />
			<div class="row">
				<button onClick={handler("on/rate")}>
					{bind("board/source/rate", (r) => (r ? `${r} fps cap` : "no cap"))}
				</button>
				<button onClick={handler("on/ask")}>ask for camera</button>
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

export function transform() {
	const { editor: makeEditor, settext } = host<Cam>()
	const inn = ensureNode("./board/transform/in", "/source/frame") // the address it reads: the board draws the wire from it
	const code = ensureNode("./board/transform/code", presets.invert) // the editor's text, a node
	const nodes = common("transform")
	const stats = { n: 0, work: 0, line: () => "" }
	stats.line = () => {
		const s = `fn ${ms(stats.work / Math.max(1, stats.n))}`
		stats.work = 0
		return s
	}
	// the function, recompiled when the text changes: nothing else restarts
	const fn = createMemo("fn", () => compile(read(code) as string))
	createMemo("status", () => (read(fn) as any).error ?? "ok")
	let lastError = ""
	createAction("on/edit", (text: string) => patch(code, [{ path: [], value: text }]))
	// out: reads the input address, runs the function. the result is a node
	createMemo("out", () => {
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

	every(nodes, stats)
	// the editor is the host's (CodeMirror): a div it draws in, placed and never touched. what is
	// typed is the host's too: it runs on/edit, debounced
	const box = Object.assign(document.createElement("div"), { className: "cm-host" })
	const editor = makeEditor(box, peep(() => read(code)) as string)
	addTeardown(() => editor.destroy())
	return (
		<Stage>
			<div class="row">
				{Object.entries(presets).map(([name, text]) => (
					<button onClick={() => settext(editor, text)}>{name}</button>
				))}
			</div>
			{box}
			<p class="note warn">{bind("status")}</p>
			<Stat />
		</Stage>
	)
}
// ---- output ----
export function output() {
	const inn = ensureNode("./board/output/in", "/transform/out")
	const nodes = common("output")
	const stats = { n: 0, draw: 0, line: () => "" }
	stats.line = () => {
		const s = `draw ${ms(stats.draw / Math.max(1, stats.n))}`
		stats.draw = 0
		return s
	}
	const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H })
	const ctx = canvas.getContext("2d")!
	// an effect: reads the address it is wired to, draws each new frame
	createEffect("draw", () => read(String(read(inn))) as ImageData | null | undefined, (img) => {
		if (!img?.data) return
		const a = performance.now()
		ctx.putImageData(img, 0, 0)
		stats.draw += performance.now() - a
		stats.n++
	})
	every(nodes, stats)
	return (
		<Stage>
			{canvas}
			<Stat />
		</Stage>
	)
}
