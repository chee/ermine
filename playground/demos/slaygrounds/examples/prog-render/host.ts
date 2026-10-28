// prog-render's host: one app writes a ui, two screens draw it through two hosts, each node getting
// the renderer that fits on that screen, and why. the world (@ermine/slaygrounds/world) does the
// processes; the renderers library (@ermine/slaygrounds/renderers, a proposal) the hosts, the
// mirror and the renderers' nodes. this file holds only what is this demo's: a canvas's pixels,
// the page, the screens (/screens/<name>: its runner, its own renderers; its mirror process runs
// with its folder there, so its own renderers are nearer than /renderers) and the wiring
import { openwith as openwithIn } from "@ermine/programs"
import * as lib from "@ermine/core/places/lib"
import {
	charHost,
	domHost,
	type Host,
	mirror,
	type Openwith,
	renderers,
	runner,
} from "@ermine/slaygrounds/renderers"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

export type { Draw, Got, Host, Renderer } from "@ermine/slaygrounds/renderers"

// a canvas's pixels: { width, pixels }, each a shade, drawn ten times as big
const shades = ["#fff", "#ffd9ea", "#ff2284"]
function pixels(el: HTMLElement, { width, pixels }: { width: number; pixels: Uint8Array }) {
	const canvas = el as HTMLCanvasElement
	const height = Math.ceil(pixels.length / width)
	canvas.width = width
	canvas.height = height
	canvas.style.width = width * 10 + "px"
	canvas.style.height = height * 10 + "px"
	const g = canvas.getContext("2d")!
	pixels.forEach((p, i) => {
		g.fillStyle = shades[p] ?? "#000"
		g.fillRect(i % width, Math.floor(i / width), 1, 1)
	})
}

// the two screens' hosts, and the keys each one's runner provides
const hosts = { dom: domHost({ pixels }), chars: charHost() }
const provides = { dom: ["dom", "canvas"], chars: ["chars"] }

// what a program is given beyond @ermine/system: the hosts, and the mirror (read there by host())
export type Extra = { hosts: typeof hosts; mirror: (h: Host, at: string) => Element }

// ---- the page: the screens side by side, the table under them ----
if (!document.getElementById("prog-render-style")) {
	const style = document.head.appendChild(document.createElement("style"))
	style.id = "prog-render-style"
	style.textContent = `
body { background: #ffff88; margin: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
	align-items: start }
[data-ermine-box] { position: relative; background: #fff; border: 1px solid #000; border-radius: 8px;
	box-shadow: 0 0 10px 2px #66003322; padding: 16px 12px 8px; min-width: 0 }
[data-ermine-box]::before { position: absolute; top: -10px; left: 10px; background: #ffff88;
	border: 1px solid #000; padding: 0 8px; font-size: 12px; font-weight: 600; white-space: nowrap }
[data-ermine-box="screens/dom/mirror"]::before { content: "screens/dom · a DOM host · key: canvas" }
[data-ermine-box="screens/chars/mirror"]::before { content: "screens/chars · a character host · key: chars" }
[data-ermine-box="why"] { grid-column: 1 / -1 }
[data-ermine-box="why"]::before { content: "node → what opens it: the nearest renderer that fits on each screen" }
pre.chars { background: #ffffea; border: 1px solid #000; margin: 0; padding: 6px 8px;
	font: 12px/1.25 Monaco, Menlo, monospace; color: #000; overflow: hidden }
pre.chars .hot { background: #eaffff; cursor: pointer }
pre.chars .hot:hover { background: #ff2284; color: #fff }
pre.chars .number { color: #2269ff; font-weight: bold }
pre.chars .h1 { font-weight: bold }
.screen h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600 }
.screen p { margin: 4px 0 }
.screen .number { color: #2269ff; font: bold 13px Monaco, Menlo, monospace }
.screen figure { margin: 6px 0 }
.screen canvas { display: block; image-rendering: pixelated; border: 1px solid #000 }
.screen section { font-size: 13px }
.screen ul { margin: 2px 0 4px; padding-left: 18px }
.screen .buttons button { margin-right: 4px }
.why { font-size: 12px }
.why p { margin: 0 0 6px }
.why code, .why td, .why th { font: 11px/1.45 Monaco, Menlo, monospace }
.why table { border-collapse: collapse; width: 100% }
.why th { text-align: left; font: 600 12px Jost, sans-serif; border-bottom: 1px solid #000 }
.why td, .why th { padding: 1px 8px 1px 0; vertical-align: top }
.why tr + tr td { border-top: 1px solid #0001 }
.why b { color: #ff2284 }
.why .no { color: #ff2284 }
.why .near { background: #ff2284; color: #fff; padding: 0 3px; border-radius: 2px }
.why .dim { color: #0007 }
.why .kind { background: #c8f6ea; padding: 0 3px; border-radius: 2px }
`
}

// ---- the world ----
const spec = (name: string) => ({
	name,
	export: name,
	at: ["screens", name, "mirror"],
	folder: ["screens", name],
})
const world = createWorld({
	render,
	processes: [{ name: "app" }, spec("dom"), spec("chars"), { name: "why", export: "why" }],
	// the mirror's openwith: programs' over the world's places, from the folder the mirror runs in
	extend: ({ at }) => {
		const folder = at.slice(0, -1)
		const openwith: Openwith = (x, options) => {
			const path = String(x).split("/").filter(Boolean)
			const id = lib.get(world.world.places, path)
			return id === undefined ? [] : openwithIn(world.world.places, id, folder, options)
		}
		// a click on a drawn node calls its action from a listener, where no call is open: it throws
		// nothing-open. said once on the console, not left uncaught
		const quiet = (h: Host): Host => ({
			...h,
			setProperty: (node, key, value) =>
				h.setProperty(
					node,
					key,
					key.startsWith("on:") && typeof value === "function"
						? () => {
							try {
								value()
							} catch (e) {
								console.warn(
									`${String(value)} from a click: ${(e as Error).message.slice(0, 90)}`,
								)
							}
						}
						: value,
				),
		})
		return { hosts, mirror: (h: Host, at: string) => mirror(quiet(h), at, openwith) }
	},
})

world.seed(() => {
	for (const name of ["dom", "chars"] as const) {
		runner(`/screens/${name}/run`, hosts[name], provides[name])
	}
})

// a reload: the program's exports written as nodes by the world, and the renderers beside them
export function reload(mod: Record<string, any>) {
	world.seed(() => {
		renderers("/renderers", mod.renderers)
		for (const name of ["dom", "chars"]) {
			renderers(`/screens/${name}/renderers`, mod.screens?.[name])
		}
	})
	world.reload(mod)
}
