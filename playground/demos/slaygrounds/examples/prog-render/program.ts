/** @jsxImportSource @ermine */
import {
	createAction,
	createMemo,
	ensureNode,
	patch,
	patchAttributes,
	peep,
	read,
	readAttributes,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind } from "@ermine/render/h"
import type { Extra, Got, Renderer } from "./host.ts"

// program.ts: edit me while it runs. four processes, one export each. the app (default) writes a
// ui and says what each node in it is (its type); two screens (dom, chars) draw that ui through
// their hosts, and each node gets the renderer that opens its type on that screen, the nearest
// that fits; why is the table of who got what. edit the title: one text node changes, and the
// counts say how few host operations each screen did. edit a renderer: the nodes it drew are
// drawn again by it. take one out: the table says what fits instead, or why nothing does

// the types: what a node is, and what a renderer opens
const TEXT = "party.chee.ermine.text"
const NUMBER = "party.chee.ermine.number"
const LIST = "party.chee.ermine.list"
const IMAGE = "party.chee.ermine.image"

// a ui is data: h(tag, attrs, ...kids), a string, or a node drawn by a renderer: at(node). an
// on:<event> attribute is the path of the method it sends to
const h = (tag: string, attrs: object = {}, ...kids: unknown[]) => ({ tag, attrs, kids })
// a node is given by its path from the root: a handle names no path to the program that holds it
const at = (path: string) => ({ node: path })

export default function app() {
	// count and presses are ./ nodes: they are there still after a reload. label and picture are
	// memos inside the process, made again at each start
	const count = ensureNode("./count", 3)
	const presses = ensureNode("./presses", [])
	const label = createMemo("label", () => `${Math.min(8, read(count) as number)} of 8 full`)
	const picture = createMemo("picture", () => heart(read(count) as number))
	for (
		const [node, type] of [[count, NUMBER], [presses, LIST], [label, TEXT], [
			picture,
			IMAGE,
		]] as const
	) {
		if (peep(() => readAttributes(node, ["ermine.type"])) !== type) {
			patchAttributes(node, [{ path: ["ermine.type"], value: type }])
		}
	}

	createAction("on/add", () => {
		patch(count, [{ path: [], value: (peep(() => read(count)) as number) + 1 }])
		const was = peep(() => read(presses)) as string[]
		patch(presses, [{
			path: [],
			value: [`+1 at ${new Date().toLocaleTimeString()}`, ...was].slice(0, 3),
		}])
	})
	createAction("on/clear", () => {
		patch(count, [{ path: [], value: 0 }])
		patch(presses, [{ path: [], value: [] }])
	})

	ensureNode(
		"ui",
		h(
			"div",
			{ class: "app" },
			h("h1", {}, "a little meter"),
			h("p", {}, "count: ", at("/count"), " · ", at("/app/label")),
			h("figure", {}, at("/app/picture")),
			h("section", {}, "presses", at("/presses")),
			h(
				"p",
				{ class: "buttons" },
				h("button", { "on:click": "/app/on/add" }, "+1"),
				" ",
				h("button", { "on:click": "/app/on/clear" }, "clear"),
			),
		),
	)
}

// the screens: each draws /app/ui through its host
// (what each is given beyond @ermine/system: the host's hosts and mirror, read by host())
export const dom = () => {
	const { mirror, hosts } = host<Extra>()
	return mirror(hosts.dom, "/app/ui")
}
export const chars = () => {
	const { mirror, hosts } = host<Extra>()
	return mirror(hosts.chars, "/app/ui")
}

// the table: each node, what it is, and what each screen got for it
export function why() {
	createMemo("rows", () => {
		const by = (screen: string) => (read(`/screens/${screen}/mirror/got`) ?? []) as Got[]
		const dom = by("dom"), chars = by("chars")
		return [...new Set([...dom, ...chars].map((g) => g.at))].map((at) => ({
			at,
			dom: dom.find((g) => g.at === at),
			chars: chars.find((g) => g.at === at),
		}))
	})
	const cell = (g?: Got) =>
		g === undefined ? <td /> : (
			<td>
				{g.pick
					? (
						<span class={g.pick.from === "/renderers" ? "" : "near"}>
							{g.pick.name} ← {g.pick.from}
						</span>
					)
					: <span class="no">✗ nothing drawn: {g.why}</span>}
				{g.fits.map((f) => <div class="dim">fits, but farther: {f.name} ← {f.from}</div>)}
				{g.misses.map((m) => (
					<div class="no">
						✗ {m.name}: needs {m.missing.join(", ")}, which no runner here provides
					</div>
				))}
			</td>
		)
	return (
		<div class="why">
			<p>
				a renderer is an opener of a type (<code>openwith</code>), run by a screen's runner,
				which provides the keys it needs. a click on either screen should send to{" "}
				<code>/app/on/…</code>: it cannot now, the mirror's listener has no call open (nothing
				is sent; the console says so)
			</p>
			<table>
				<tr>
					<th>node</th>
					<th>is</th>
					<th>screens/dom got</th>
					<th>screens/chars got</th>
				</tr>
				{bind("rows", (list: any[]) =>
					list.map((r) => (
						<tr>
							<td>{r.at}</td>
							<td>
								<span class="kind">
									{((r.dom ?? r.chars).type ?? "?").replace("party.chee.ermine.", "")}
								</span>
							</td>
							{cell(r.dom)}
							{cell(r.chars)}
						</tr>
					)))}
			</table>
			<p class="dim">
				last draw, dom: {bind("/screens/dom/mirror/ops", ops)}; chars:{" "}
				{bind("/screens/chars/mirror/ops", ops)}
			</p>
		</div>
	)
}
const ops = (o: Record<string, number>) => {
	const n = Object.values(o).reduce((a, b) => a + b, 0)
	return `${n} op${n === 1 ? "" : "s"} ${
		Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ")
	}`
}

// a heart, filled from the bottom, a row per count: 0 none, 1 outline, 2 filled
function heart(n: number) {
	const shape = [
		".##...##.",
		"####.####",
		"#########",
		"#########",
		".#######.",
		"..#####..",
		"...###...",
		"....#....",
	]
	const pixels = new Uint8Array(9 * 8)
	shape.forEach((row, y) =>
		[...row].forEach((c, x) => {
			if (c === "#") pixels[y * 9 + x] = y >= 8 - n ? 2 : 1
		})
	)
	return { width: 9, pixels }
}

// what opens a type: renderers at /renderers (a folder whose children are the candidates). each
// opens one type; one may need a key, which only some screens' runners provide. draw is given the
// screen's host and what it made and showed last time
export const renderers: Record<string, Renderer> = {
	// changing text (a memo's) and fixed text look the same here
	text: {
		opens: TEXT,
		draw(host, s, was, before) {
			if (!was) return host.text(String(s))
			if (s !== before) host.setText(was, String(s))
			return was
		},
	},
	number: {
		opens: NUMBER,
		draw(host, n, was, before) {
			if (was) {
				if (n !== before) host.setText(host.firstChild(was), String(n))
				return was
			}
			const span = host.element("span")
			host.setProperty(span, "class", "number")
			host.insert(span, host.text(String(n)), null)
			return span
		},
	},
	// one li per item, its text patched only where the item changed
	list: {
		opens: LIST,
		draw(host, items, was, before = []) {
			const ul = was ?? host.element("ul")
			let li = host.firstChild(ul)
			items.forEach((item: unknown, i: number) => {
				if (!li) {
					li = host.element("li")
					host.insert(li, host.text(String(item)), null)
					host.insert(ul, li, null)
				} else if (item !== before[i]) host.setText(host.firstChild(li), String(item))
				li = host.nextSibling(li)
			})
			while (li) {
				const next = host.nextSibling(li)
				host.remove(ul, li)
				li = next
			}
			return ul
		},
	},
	// pixels on a canvas: only where a screen's runner provides canvas (screens/dom's does)
	canvas: {
		opens: IMAGE,
		needs: ["canvas"],
		draw(host, v, was, before) {
			const canvas = was ?? host.element("canvas")
			if (v !== before) host.setProperty(canvas, "pixels", v)
			return canvas
		},
	},
}

// a screen's own renderers, at /screens/<name>/renderers: nearer than /renderers on that screen's
// walk. the character screen draws images in block characters (it needs chars, which its runner
// provides). take it out: nothing on that screen opens an image, and the table says why
export const screens: Record<string, Record<string, Renderer>> = {
	chars: {
		blocks: {
			opens: IMAGE,
			needs: ["chars"],
			draw(host, { width, pixels }, was, before) {
				const rows = []
				for (let y = 0; y * width < pixels.length; y++) {
					const row = [...pixels.subarray(y * width, (y + 1) * width)]
					rows.push(row.map((p) => [" ", "░", "█"][p].repeat(2)).join(""))
				}
				const text = rows.join("\n")
				if (was) {
					if (before?.pixels !== pixels) host.setText(host.firstChild(was), text)
					return was
				}
				const pre = host.element("pre")
				host.insert(pre, host.text(text), null)
				return pre
			},
		},
	},
}
