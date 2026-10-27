/** @jsxImportSource ermine-h */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	createWriter,
	ensureNode,
	patch,
	peep,
	read,
} from "@ermine/system"
import { bind, handler } from "ermine-h"

// toy-pet: a pet that gets hungry (every few seconds, or when you let a while pass). everything it is lives in nodes (name, hunger, fed, loved).
// the big face and the little widget are two views of the same nodes: each binding is its own,
// so the mood is bound twice. edit a face below and save: the pet stays as hungry as it was
const faces = ["😻", "😺", "😿", "🙀"]
const css = `
.pet{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:18px;max-width:320px;margin:0 auto;text-align:center;font-family:Jost,system-ui,sans-serif}
.pet h2{margin:0 0 4px;font-size:22px}
.pet .tag{display:inline-block;background:#fff7a8;border:1px solid #000;padding:0 10px;transform:skew(-8deg);font-size:13px}
.pet .face{font-size:96px;line-height:1.2;cursor:pointer;user-select:none}
.pet .belly{font-size:20px;letter-spacing:2px;margin:6px 0 12px;min-height:26px}
.pet .row{display:flex;gap:8px;justify-content:center}
.pet .row button{font-size:16px}
.pet .widget{margin-top:16px;border:1px dashed #000;padding:6px;font-size:13px;background:#fffdf0}
`

export default function program() {
	// the pet's state is saved under ./: a reload finds the pet as hungry as it was
	const name = ensureNode("./name", "Mochi")
	const hunger = ensureNode("./hunger", 3) // 0 stuffed .. 10 starving
	const fed = ensureNode("./fed", 0)
	const loved = ensureNode("./loved", 0)
	const get = (x: unknown) => read(x as never) as number
	const bump = (x: unknown, f: (n: number) => number) =>
		patch(x as never, [{ path: [], value: f(peep(() => get(x))) }])

	createMemo("mood", () => {
		const h = get(hunger)
		return h <= 2 ? faces[0] : h <= 5 ? faces[1] : h <= 8 ? faces[2] : faces[3]
	})
	createMemo("belly", () => {
		const h = get(hunger)
		return "🍙".repeat(Math.max(0, 5 - Math.ceil(h / 2))) + "·".repeat(Math.ceil(h / 2))
	})
	createMemo("line", () => `${read(name)} · fed ${read(fed)}× · loved ${read(loved)}×`)

	createAction("on/feed", () => {
		bump(hunger, (h) => Math.max(0, h - 3))
		bump(fed, (n) => n + 1)
	})
	createAction("on/pet", () => bump(loved, (n) => n + 1))
	createAction("on/rename", (n: string) => patch(name, [{ path: [], value: n }]))
	// hungry: a timer, written through a writer made here in setup, lets a while pass every 8
	// seconds; the button lets one pass at once
	createAction("on/wait", () => bump(hunger, (h) => Math.min(10, h + 1)))
	const withWriter = createWriter()
	const timer = setInterval(() => withWriter(() => bump(hunger, (h) => Math.min(10, h + 1))), 8000)
	addTeardown(() => clearInterval(timer))

	// a little bounce when it eats, a hop when it is loved: effects on fed and loved (the first
	// run has no before: no bounce). the face is the element the jsx made, handed back by ref
	let face: HTMLElement | undefined
	const wiggle = (frames: Keyframe[], ms: number) => (_: unknown, before: unknown) => {
		if (before !== undefined) face?.animate(frames, ms)
	}
	createEffect(
		"bounce",
		() => get(fed),
		wiggle([{ transform: "scale(1)" }, { transform: "scale(1.25) rotate(-6deg)" }, {
			transform: "scale(1)",
		}], 300),
	)
	createEffect(
		"boing",
		() => get(loved),
		wiggle([{ transform: "translateY(0)" }, { transform: "translateY(-14px)" }, {
			transform: "translateY(0)",
		}], 250),
	)

	// a new name: asked when the button is pressed; none given, no call
	const asked = () => {
		const n = prompt("a new name?")
		return n ? [n] : undefined
	}
	return (
		<div class="pet">
			<style>{css}</style>
			<h2>{bind("name")}</h2>
			<span class="tag">a pet that needs you</span>
			<div class="face" title="pet me" ref={(e) => (face = e)} onClick={handler("on/pet")}>
				{bind("mood")}
			</div>
			<div class="belly">{bind("belly")}</div>
			<div class="row">
				<button onClick={handler("on/feed")}>🍙 feed</button>
				<button onClick={handler("on/rename", asked)}>✏️ rename</button>
				<button onClick={handler("on/wait")}>⏳ a while passes</button>
			</div>
			<small>the pet gets hungry every 8 seconds, or when a while passes</small>
			<div class="widget">
				widget: {bind("mood")} {bind("line")}
			</div>
		</div>
	)
}
