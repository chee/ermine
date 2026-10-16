/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"

// toy-stickers: pick a sticker, click the page to stick it, click a sticker to peel it. every
// sticker is its own node under stickers/items (an emoji, x, y, a tilt), their order is a list of
// ids, like todos. "mix" moves all of them in ONE handler: look at the inspector's moments. each
// sticker's place and face are bound to its own node, so a mix slides them where they now are
const emoji = ["🌸", "🐰", "🍒", "⭐", "🍄", "🦊", "🧁", "🌈", "👑", "🐸"]
const css = `
.stk{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 4px 24px #ff228433;padding:14px;max-width:480px;margin:0 auto;font-family:Jost,system-ui,sans-serif}
.stk .pal{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.stk .pal button{font-size:22px;padding:0 6px}
.stk .pal button.on{background:#fff7a8;box-shadow:2px 2px 0 #ff2284}
.stk .page{position:relative;height:260px;border:1px dashed #000;background:#fffdf0 radial-gradient(#0002 1px,transparent 1px) 0 0/16px 16px;overflow:hidden;cursor:copy}
.stk .page span{position:absolute;font-size:40px;line-height:1;cursor:pointer;transition:left .4s,top .4s;user-select:none;filter:drop-shadow(1px 1px 0 #000)}
.stk .page span:hover{transform:scale(1.2) !important}
.stk .row{display:flex;gap:8px;margin-top:8px;align-items:center}
`

type Sticker = { e: string; x: number; y: number; r: number }

// the sheet is saved under ./sheet (the process is "stickers": never a ./ name): a reload finds the
// stickers where they were
export default function program({ open, read, edit, remove, memo, method }: API) {
	const order = open("./sheet/order", ["s1", "s2", "s3"])
	open("./sheet/items/s1", { e: "🌸", x: 60, y: 60, r: -10 })
	open("./sheet/items/s2", { e: "🐰", x: 200, y: 110, r: 8 })
	open("./sheet/items/s3", { e: "🍒", x: 330, y: 50, r: 14 })
	const pick = open("./sheet/pick", "⭐")
	const ids = () => read(order) as string[]
	const sticker = (id: string) => `./sheet/items/${id}`
	memo("count", () => ids().length)
	memo("words", () => {
		const n = ids().length
		return n === 0
			? "an empty page, how sad"
			: n < 8
			? `${n} stickers`
			: `${n} stickers, wow, so busy`
	})

	const rnd = (a: number, b: number) => Math.round(a + Math.random() * (b - a))
	method("on/pick", (e: string) => edit(pick, () => e))
	method("on/stick", (x: number, y: number) => {
		const id = crypto.randomUUID().slice(0, 4)
		open(sticker(id), { e: read(pick), x, y, r: rnd(-15, 15) })
		edit(order, (d: string[]) => void d.push(id))
	})
	method("on/peel", (id: string) => {
		edit(order, (d: string[]) => void d.splice(d.indexOf(id), 1))
		remove(sticker(id))
	})
	// every sticker moved in one method: one moment in the inspector, each a change of three fields
	method("on/mix", () => {
		for (const id of ids()) {
			edit(sticker(id), (d: Sticker) => {
				d.x = rnd(10, 410)
				d.y = rnd(10, 200)
				d.r = rnd(-20, 20)
			})
		}
	})
	method("on/clear", () => {
		for (const id of ids()) remove(sticker(id))
		edit(order, (d: string[]) => void d.splice(0))
	})

	// where a click on the page is, as the sticker's corner
	const spot = (e: MouseEvent) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
		return [Math.round(e.clientX - r.left - 20), Math.round(e.clientY - r.top - 20)]
	}
	// a sticker's place, from its node
	const placed = (v: Sticker) => `left:${v.x}px;top:${v.y}px;transform:rotate(${v.r}deg)`
	// a click on a sticker peels it, and is not a click on the page under it
	const peel = (id: string) => (e: Event) => {
		e.stopPropagation()
		return [id]
	}
	return (
		<div class="stk">
			<style>{css}</style>
			<div class="pal">
				{emoji.map((e) => (
					<button
						class={bind("sheet/pick", (p) => (p === e ? "on" : ""))}
						onClick={handler("on/pick", [e])}
					>
						{e}
					</button>
				))}
			</div>
			<div class="page" onClick={handler("on/stick", spot)}>
				{bind("sheet/order", (list: string[]) =>
					list.map((id) => (
						<span
							key={id}
							style={bind(`sheet/items/${id}`, placed)}
							onClick={handler("on/peel", peel(id))}
						>
							{bind(`sheet/items/${id}`, (v: Sticker) => v.e)}
						</span>
					)))}
			</div>
			<div class="row">
				<button onClick={handler("on/mix")}>🌀 mix</button>
				<button onClick={handler("on/clear")}>🧽 peel all</button>
				{bind("words")}
			</div>
		</div>
	)
}
