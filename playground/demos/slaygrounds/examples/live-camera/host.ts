// live-camera's host: the world (@ermine/slaygrounds/world), three processes (source, transform,
// output: one export each of program.ts) and a board they sit on. the board is the host's: a card
// per process (the process's view is rendered into the card's body), a wire per `in` node, a drag
// writing the card's `pos` through the process's own on/move. the one extra tool is the code editor
// (CodeMirror, bundled beside this by vite as cm.js: the frame's import map has only @ermine/*).
// the host keeps the clocks, since nothing is open in a frame callback or a timer: each frame the
// source's on/frame, each second every process's on/stats, and the editor's typing (debounced) the
// transform's on/edit, all run as the host (executeAction)
import { createWorld } from "@ermine/slaygrounds/world"
import { executeAction, peep, read } from "@ermine/system"
import { render } from "ermine-h"

const cm = await import(
	new URL("examples/live-camera/cm.js", parent.__base ?? parent.location.origin + "/").href
)

const names = ["source", "transform", "output"] as const
const layout = { source: [8, 70], transform: [208, 20], output: [494, 70] }

const style = document.head.appendChild(document.createElement("style"))
style.textContent = `
html,body{height:100%}
body{margin:0;background:#fffbe0;overflow:hidden}
#board{position:relative;width:100%;height:100vh;background:radial-gradient(#0002 1px,transparent 1px) 0 0/20px 20px}
.card{position:absolute;background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;display:flex;flex-direction:column;font-family:Jost,system-ui,sans-serif;font-size:13px}
.card>header{display:flex;gap:8px;align-items:center;padding:4px 10px;border-bottom:1px solid #000;cursor:grab;user-select:none;background:#fffbe0}
.card>header b{font-weight:600}
.card>header small{margin-left:auto;color:#000a}
.card>div.body{padding:8px;display:flex;flex-direction:column;gap:6px;min-height:0;flex:1}
.port{position:absolute;top:34px;z-index:2;width:12px;height:12px;border:1px solid #000;border-radius:50%;background:#40dcba}
.port.in{left:-7px;background:#fff}.port.out{right:-7px}
svg.wires{position:absolute;inset:0;pointer-events:none;overflow:visible}
svg.wires path{fill:none;stroke:#ff2284;stroke-width:2}
svg.wires text{font:600 11px Jost,system-ui,sans-serif;fill:#ff2284;paint-order:stroke;stroke:#fffbe0;stroke-width:4px}
.card canvas{border:1px solid #000;image-rendering:pixelated;background:#000}
.stat{font-variant-numeric:tabular-nums;font-size:12px;display:flex;gap:10px;flex-wrap:wrap}
.stat b{color:#ff2284;font-weight:600}
.card .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.card p.note{margin:0;font-size:12px}
.card p.note.warn{color:#ff2284}
.card .cm-host{border:1px solid #000;flex:1;min-height:150px;overflow:hidden}
`
const board = document.body.appendChild(
	Object.assign(document.createElement("div"), { id: "board" }),
)
const wires = board.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"))
wires.setAttribute("class", "wires")

// each process has a card: a title bar to drag by, ports, a body its view is rendered into
const cards = new Map<string, { el: HTMLElement; body: HTMLElement; head: HTMLElement }>()
function card(name: string) {
	const there = cards.get(name)
	if (there) return there
	const el = board.appendChild(document.createElement("div"))
	el.className = "card " + name
	const head = el.appendChild(document.createElement("header"))
	head.innerHTML = `<b>${name}</b><small></small>`
	el.append(
		Object.assign(document.createElement("i"), { className: "port in" }),
		Object.assign(document.createElement("i"), { className: "port out" }),
	)
	const body = el.appendChild(document.createElement("div"))
	body.className = "body"
	el.style.left = layout[name as keyof typeof layout][0] + "px"
	el.style.top = layout[name as keyof typeof layout][1] + "px"
	// a drag is a send to the process's on/move (a pointer event has no scope open)
	head.onpointerdown = (e) => {
		const x0 = e.clientX - el.offsetLeft, y0 = e.clientY - el.offsetTop
		head.setPointerCapture(e.pointerId)
		head.onpointermove = (e) => {
			const pos = [e.clientX - x0, e.clientY - y0]
			el.style.left = pos[0] + "px"
			el.style.top = pos[1] + "px"
			world.world.call([name, "on", "move"], [pos])
			wire()
		}
		head.onpointerup = () => (head.onpointermove = head.onpointerup = null)
	}
	const c = { el, body, head }
	cards.set(name, c)
	return c
}

const world = createWorld({
	// the world makes a box per process; it goes into the process's card
	render: (into, view, process: any) => {
		const c = card(process.name)
		if (into.parentNode !== c.body) c.body.append(into)
		;(into as HTMLElement).style.display = "contents"
		return render(into, view, process)
	},
	processes: names.map((name) => ({ name, export: name })),
	extend: ({ at }) => ({
		// what is typed runs the process's on/edit, 120ms after the last key
		editor: (parent: HTMLElement, doc: string) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const view = cm.createEditor(parent, doc, (text: string) => {
				clearTimeout(timer)
				timer = setTimeout(() => act(at.join("/"), "edit", text), 120)
			})
			// the view, its destroy clearing the timer too
			const destroy = view.destroy.bind(view)
			view.destroy = () => (clearTimeout(timer), destroy())
			return view
		},
		settext: (view: unknown, text: string) => cm.setText(view, text),
	}),
})
const e = world.ermine

// an action of a process run as the host; none there (not started, or stopped): nothing
function act(process: string, name: string, ...args: unknown[]) {
	if (!world.world.processes.has(process)) return
	try {
		e.within(() => executeAction(`/${process}/on/${name}`, ...args))
	} catch { /* the process is not up yet */ }
}
// a node's value as the host reads it, none: undefined
const peek = (path: string) => {
	try {
		return e.within(() => peep(() => read(path)))
	} catch {
		return undefined
	}
}

// ---- the clocks ----
// the source's frame loop: at 30 a frame at most every 30ms, 60 at the display's rate, 0 as fast as
// the page lets it (a message, not a frame)
const channel = new MessageChannel()
let last = 0, raf = 0
function tick(now: number) {
	const r = peek("/board/source/rate")
	if (!(r === 30 && now - last < 30)) {
		last = now
		act("source", "frame")
	}
	next()
}
function next() {
	if (peek("/board/source/rate") === 0 && world.world.processes.has("source")) {
		channel.port2.postMessage(0)
	} else raf = requestAnimationFrame(tick)
}
channel.port1.onmessage = () => tick(performance.now())
next()
// and a second: each process's line of numbers
setInterval(() => names.forEach((name) => act(name, "stats")), 1000)

// a wire per `in` node: the node holds the address it reads, the line goes from the card that owns
// the address (its first name) to the card with the `in`
function wire() {
	const lines: string[] = []
	for (const name of names) {
		const address = peek(`/board/${name}/in`)
		if (address === undefined) continue
		const from = cards.get(String(address).split("/")[1])
		const to = cards.get(name)
		if (!from || !to) continue
		const x1 = from.el.offsetLeft + from.el.offsetWidth, y1 = from.el.offsetTop + 40
		const x2 = to.el.offsetLeft, y2 = to.el.offsetTop + 40
		const dx = Math.max(12, Math.abs(x2 - x1) / 2)
		lines.push(`<path d="M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}"/>`)
		to.head.querySelector("small")!.textContent = "in " + address
	}
	wires.innerHTML = lines.join("")
}
addEventListener("resize", wire)

export function reload(mod: Record<string, unknown>) {
	world.reload(mod)
	// where each card was left (a node the program saves)
	for (const name of names) {
		const xy = peek(`/board/${name}/pos`) as number[] | undefined
		if (xy) {
			const c = card(name)
			c.el.style.left = xy[0] + "px"
			c.el.style.top = xy[1] + "px"
		}
	}
	wire()
}
