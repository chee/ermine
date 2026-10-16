/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { count } from "@ermine/util/walk-string"
import { bind, handler } from "ermine-h"

// big-duet: two people, one text. /text is one string node; duet owns it and its one handler,
// type(a, b, text): a range patch, positions in code points. cherry and mint are two processes,
// each a pane: a keystroke is a call to duet (the change says who called), a caret is the person's
// own node (/caret-cherry: an anchor and a head, so a selection keeps its direction), and each pane
// draws the others' selections and carets where they are. a remote edit moves your anchor and head
// through its patch; your own never puts anything back. invite the poet: a third process typing into the same text on a
// timer, wherever its caret is. the list at the bottom is every change, as its patch.
// the views are jsx: what is a node is bound (the counts, the poet's button, each pane's other
// carets, the panes themselves: the people's node values); the textarea and the marks behind it
// are the program's own, driven by its effects, and ermine-h never writes into them
const START = "two rabbits write one poem.\n\n"
const POEM = [
	"the lemon moon is out tonight,",
	"a cherry in the grass,",
	"we dig a little burrow here",
	"and watch the changes pass. 🐇",
	"",
]
const WHO = {
	cherry: { colour: "#ff2284", icon: "🍒" },
	mint: { colour: "#1fb894", icon: "🌿" },
	poet: { colour: "#2269ff", icon: "📜" },
}
const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 14px/1.3 Jost, system-ui, sans-serif; color: #000 }
.duet { display: flex; flex-direction: column; gap: 10px; padding: 12px; height: 100vh; box-sizing: border-box }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.tag { display: inline-block; background: #fff; border: 1px solid #000; padding: 1px 10px;
	transform: skew(-8deg); font-weight: 600 }
.title { background: #ff2284; color: #fff; font-size: 17px }
.fill { flex: 1 }
button { font: inherit; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 1px 10px; box-shadow: 2px 2px 0 #000; cursor: pointer;
	transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
button:active { transform: translate(1px, 1px); box-shadow: none }
button.on { background: #2269ff; color: #fff }
.panes { display: flex; gap: 12px; flex: 1; min-height: 0 }
.panes > span, .panes .box { flex: 1; min-width: 0; display: flex }
.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #fff;
	border: 1px solid #000; border-radius: 6px; box-shadow: 0 0 10px 2px #66003322; overflow: hidden }
.pane > header { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid #000;
	font-size: 12px }
.pane > header .tag { color: #fff; background: var(--c) }
.pane > header .where { margin-left: auto; font: 11px Monaco, ui-monospace, monospace; color: #0008 }
.paper { position: relative; flex: 1; min-height: 120px }
.paper textarea, .paper .back { position: absolute; inset: 0; margin: 0; border: 0; padding: 12px 14px;
	font: 15px/1.6 Jost, system-ui, sans-serif; white-space: pre-wrap; overflow-wrap: break-word;
	box-sizing: border-box; overflow-y: auto; letter-spacing: 0 }
.paper .back { color: transparent; pointer-events: none; overflow: hidden }
.paper textarea { background: none; resize: none; outline: none; caret-color: var(--c) }
.paper textarea::selection { background: color-mix(in srgb, var(--c) 30%, transparent) }
.back mark { color: transparent; background: color-mix(in srgb, var(--c) 22%, transparent) }
.back .caret { position: relative }
.back .caret::before { content: ""; position: absolute; left: -1px; top: .15em; height: 1.3em;
	border-left: 2px solid var(--c) }
.back .caret::after { content: attr(data-who); position: absolute; left: -1px; top: -1.05em;
	font: 600 10px/1.2 Jost, system-ui, sans-serif; color: #fff; background: var(--c); padding: 0 4px;
	white-space: nowrap; border-radius: 2px 2px 2px 0 }
.edits { flex: none; background: #fff; border: 1px solid #000; border-radius: 2px; padding: 4px 8px;
	font: 11.5px/1.55 Monaco, ui-monospace, monospace; height: 8.2em; overflow: hidden }
.edits:empty::before { content: "every change to /duet/text lands here, as its patch: type in either pane";
	color: #0008 }
.edits div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.edits b { display: inline-block; min-width: 76px }
.edits .p { color: #0009 }
`

// what a process is given besides the api: the host's change(x), the last change of x's value as
// its patches and who called, by name
type Duet = API & {
	change: (x: unknown) => { patches: any[]; caller?: string } | undefined
}

// the text's owner: the one node (./text, saved, so a reload keeps the poem), and the one way to
// change it
export default function duet({ open, read, edit, method, memo, effect, teardown, change }: Duet) {
	const style = document.head.appendChild(document.createElement("style"))
	style.textContent = LOOK
	const font = document.head.appendChild(Object.assign(document.createElement("link"), {
		rel: "stylesheet",
		href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap",
	}))
	teardown(() => (style.remove(), font.remove()))
	const text = open("./text", START)
	method(
		"on/type",
		(a: number, b: number, s: string) => edit(text, [{ path: [], range: [a, b], value: s }]),
	)
	memo("words", () => (read(text) as string).split(/\s+/).filter(Boolean).length)

	// every change to the text, as it lands: who called, and its patch. a log the program draws
	// itself (a binding shows a node's value, and this is each change's header)
	const edits = el("div", "edits")
	effect("log", () => change(text), (c, before) => {
		if (before === undefined || !c?.patches.length) return
		const who = c.caller ?? "?"
		const row = el("div")
		const w = WHO[who] ?? { colour: "#000", icon: "·" }
		row.innerHTML = `<b style="color:${w.colour}">${w.icon} ${who}</b> <span class="p"></span>`
		row.querySelector(".p").textContent = c.patches.map(say).join(", ")
		edits.prepend(row)
		while (edits.childElementCount > 7) edits.lastChild.remove()
	})

	// a pane is a person's view: their node's value (the box their view is drawn in)
	const pane = (v: unknown) => (v instanceof Node ? v : undefined)
	const writing = (on: boolean) => (on ? "📜 the poet is writing (stop)" : "📜 invite the poet")
	return (
		<div class="duet">
			<div class="top">
				<span class="tag title">✍️ big-duet</span>
				<span class="tag words">
					{bind("text", (v: string) =>
						`${count(v)} characters · ${v.split(/\s+/).filter(Boolean).length} words`)}
				</span>
				<span class="fill" />
				<button
					class={bind("/writing", (on) => (on ? "on" : ""))}
					onClick={handler("/poet/on/toggle")}
				>
					{bind("/writing", writing)}
				</button>
			</div>
			<div class="panes">
				{bind("/cherry", pane)}
				{bind("/mint", pane)}
			</div>
			{edits}
		</div>
	)
}

// a person: a pane on the text, a caret of their own
export function person(
	{ open, read: get, edit, method, memo, effect, args, change }: Duet,
) {
	const name = args[0]
	const me = WHO[name]
	// a selection is an anchor (where it started) and a head (where the caret is): its direction
	// kept. ./caret-<name>: saved, so a reload finds the caret where it was
	const caret = open(`./caret-${name}`, { anchor: count(START), head: count(START) })
	const put = (c: { anchor: number; head: number }) => edit(caret, [{ path: [], value: c }])
	method("on/caret", (anchor: number, head: number) => {
		const c = ends(get(caret))
		if (c.anchor !== anchor || c.head !== head) put({ anchor, head })
	})
	const textItem = "/text"
	const read = () => get(textItem) as string
	// the others' selections, as this pane draws them: a node of its own, so the graph shows it
	const others = memo(
		"others",
		() =>
			Object.keys(WHO).filter((n) => n !== name).flatMap((n) => {
				const c = get(`/caret-${n}`)
				if (!c) return []
				// the poet's caret only while it writes
				if (n === "poet" && !get("/writing")) return []
				return [{ n, ...ends(c) }]
			}),
	)

	// the textarea and the marks behind it: the program's own, handed back by ref (the same
	// elements after a reload: ermine-h keeps them in place)
	let area: HTMLTextAreaElement
	let back: HTMLElement

	// a keystroke: what changed between the text and the textarea, as one splice, in code points
	const splice = () => {
		const was = read()
		const now = area.value
		let p = 0
		while (p < was.length && p < now.length && was[p] === now[p]) p++
		if (p > 0 && low(was.charCodeAt(p))) p--
		let s = 0
		while (
			s < was.length - p && s < now.length - p &&
			was[was.length - 1 - s] === now[now.length - 1 - s]
		) s++
		if (s > 0 && low(was.charCodeAt(was.length - s))) s--
		const a = count(was.slice(0, p)), b = count(was.slice(0, was.length - s))
		return [a, b, now.slice(p, now.length - s)]
	}
	// where the textarea's selection is, as anchor and head in code points
	const selection = () => {
		const v = area.value
		const start = count(v.slice(0, area.selectionStart)),
			end = count(v.slice(0, area.selectionEnd))
		return area.selectionDirection === "backward"
			? { anchor: end, head: start }
			: { anchor: start, head: end }
	}
	const select = ({ anchor, head }) => {
		const cps = [...area.value]
		const unit = (n) => cps.slice(0, n).join("").length
		area.setSelectionRange(
			unit(Math.min(anchor, head)),
			unit(Math.max(anchor, head)),
			anchor > head ? "backward" : "forward",
		)
	}
	// the caret told once the browser has moved it (a key, selectionchange, a click, a drag), as it
	// is then: never set back from here. unmoved: no call
	const moved = () => {
		const now = selection(), was = ends(get(caret))
		return now.anchor !== was.anchor || now.head !== was.head ? [now.anchor, now.head] : undefined
	}
	const tell = handler("on/caret", moved)

	// the text changed. my own change is in the textarea already: nothing is put back. someone
	// else's: its patches put in place, and my selection, as the textarea has it now, moved through
	// them (anchor and head each), so a key going on keeps going
	effect("sync", () => [read(), change(textItem)] as const, ([v, c]) => {
		if (area.value === v) return
		// where the reader is: kept, or kept at the bottom if they were there (as a chat log is)
		const { scrollTop, scrollLeft } = area
		const bottom = scrollTop + area.clientHeight >= area.scrollHeight - 4
		// written only when it moved: a write, even of the same number, stops a wheel's smooth scroll
		const stay = () => {
			const top = bottom ? area.scrollHeight - area.clientHeight : scrollTop
			if (Math.abs(area.scrollTop - top) >= 1) area.scrollTop = top
			if (area.scrollLeft !== scrollLeft) area.scrollLeft = scrollLeft
			back.scrollTop = area.scrollTop
		}
		const who = c?.caller
		const patches = c?.patches ?? []
		const strings = patches.length &&
			patches.every((p) => p.path.length === 0 && p.range && typeof (p.value ?? "") === "string")
		if (who !== name && strings) {
			let { anchor, head } = selection()
			for (const p of patches) {
				const cps = [...area.value]
				const unit = (n) => cps.slice(0, n).join("").length
				area.setRangeText(p.value ?? "", unit(p.range[0]), unit(p.range[1]), "preserve")
				anchor = shift(anchor, p)
				head = shift(head, p)
			}
			if (area.value === v) {
				// the textarea moved it the same way (setRangeText's own rule): left alone, so a key
				// going on (up and down keep their column) is not cut off
				const now = selection()
				if (now.anchor !== anchor || now.head !== head) select({ anchor, head })
				stay()
				const was = ends(get(caret))
				if (was.anchor !== anchor || was.head !== head) put({ anchor, head })
				return
			}
		}
		// out of step (a reload, the first draw): the whole text, and my caret from my node
		area.value = v
		select(ends(get(caret)))
		stay()
	})
	// the others' selections and carets, drawn behind the text where they are
	effect("marks", () => [read(), get(others) ?? []] as const, ([v, them]) => {
		back.innerHTML = draw(v, them)
		back.scrollTop = area.scrollTop
	})
	const heads = (others: { n: string; head: number }[]) =>
		others.map((o) => `${WHO[o.n].icon} ${o.head}`).join("  ")
	return (
		<section class="pane" style={`--c: ${me.colour}`}>
			<header>
				<span class="tag">{me.icon} {name}</span>
				<span>you, typing here</span>
				<span class="where">{bind("others", heads)}</span>
			</header>
			<div class="paper">
				<div class="back" ref={(e) => (back = e)} />
				<textarea
					spellcheck={false}
					ref={(e) => (area = e)}
					onInput={handler("/duet/on/type", splice)}
					onSelectionchange={tell}
					onKeyUp={tell}
					onMouseUp={tell}
					onFocus={tell}
					onScroll={() => {
						back.scrollTop = area.scrollTop
					}}
				/>
			</div>
		</section>
	)
}

// the poet: types its poem a letter at a time, at its caret, while it is on
export function poet({ open, read, edit, method, send, effect, teardown, change }: Duet) {
	// the flag and the caret are saved (./writing: the person's view reads it as /writing); the
	// poem's place is inside, and starts again at a reload
	const writing = open("./writing", false)
	const caret = open("./caret-poet", { anchor: 0, head: 0 })
	const line = open("line", 0)
	const left = open("left", "")
	const put = (c: { anchor: number; head: number }) => edit(caret, [{ path: [], value: c }])
	method("on/toggle", () => {
		const going = !read(writing)
		// starting: at the end of the text
		if (going) {
			const end = count(read("/text") as string)
			put({ anchor: end, head: end })
		}
		edit(writing, [{ path: [], value: going }])
	})
	method("on/tick", () => {
		if (!read(writing)) return
		let rest = read(left) as string
		if (!rest) {
			const n = read(line) as number
			rest = POEM[n % POEM.length] + "\n"
			edit(line, [{ path: [], value: n + 1 }])
		}
		const ch = [...rest][0]
		const { head } = ends(read(caret))
		send("/duet/on/type", head, head, ch)
		put({ anchor: head + 1, head: head + 1 })
		edit(left, [{ path: [], value: [...rest].slice(1).join("") }])
	})
	// a timer writes as the process: the tick is a method only to show up in the graph
	const every = setInterval(() => send("on/tick"), 120)
	teardown(() => clearInterval(every))
	// someone else's edit moves the poet's caret too
	effect("follow", () => change("/text"), (c, before) => {
		// the first act is a change from before this run (its caller a process that is gone)
		if (before === undefined || !c || c.caller === "poet") return
		const { head } = ends(read(caret))
		let a = head
		for (const p of c.patches) a = shift(a, p)
		if (a !== head) put({ anchor: a, head: a })
	})
}

// a position after a patch to the string, as a textarea's setRangeText moves its selection: past
// what it took, moved by what it put in its place; inside what it took, to its start; at its start
// or before, the same (an insert right at your caret leaves your caret before it)
function shift(pos, p) {
	if (!p.range) return pos
	const [a, b] = p.range
	const n = count(p.value ?? "")
	if (pos > b) return pos + n - (b - a)
	if (pos > a) return a
	return pos
}

// a caret node's two ends (one kept from before anchor and head: at and to)
const ends = (c) => ({ anchor: c?.anchor ?? c?.at ?? 0, head: c?.head ?? c?.to ?? 0 })

// the text, the others' selections marked from one end to the other, their carets at the head
function draw(text, others) {
	const cps = [...text]
	const cuts = new Set([0, cps.length])
	for (const o of others) {
		;(cuts.add(Math.min(o.anchor, o.head)), cuts.add(Math.max(o.anchor, o.head)))
	}
	const at = [...cuts].filter((x) => x >= 0 && x <= cps.length).sort((x, y) => x - y)
	let html = ""
	for (let i = 0; i < at.length; i++) {
		for (const o of others) {
			if (o.head === at[i]) {
				html += `<span class="caret" style="--c:${WHO[o.n].colour}" data-who="${
					WHO[o.n].icon
				} ${o.n}"></span>`
			}
		}
		if (i === at.length - 1) break
		const piece = escape(cps.slice(at[i], at[i + 1]).join(""))
		const over = others.find((o) =>
			Math.min(o.anchor, o.head) <= at[i] && Math.max(o.anchor, o.head) >= at[i + 1] &&
			o.anchor !== o.head
		)
		html += over ? `<mark style="--c:${WHO[over.n].colour}">${piece}</mark>` : piece
	}
	// a last empty line has a height only with something on it
	return html + "​"
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
const low = (c) => (c & 0xfc00) === 0xdc00
function say(p) {
	const at = p.path.join("/") + (p.range ? `[${p.range}]` : "")
	return "value" in p ? `${at} = ${JSON.stringify(p.value)}` : `${at} removed`
}
function el(tag, className = "") {
	const e = document.createElement(tag)
	if (className) e.className = className
	return e
}
