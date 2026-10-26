/// <reference lib="dom" />
// code.ts: the page's own source, to read. a few of its files, brought in as text (vite's ?raw),
// shown with line numbers in the dock's code window, and the site a write came from (a change's
// external site: file, line, column) as a link that opens its file there, the line lit in lemon.
// a live function's code too, as fn.toString() gives it: what really runs
//
// a site's line is where the browser ran it: in a vite dev server, the module as served (types
// taken out, so lines move). each of these files' served module carries a source map: read once,
// it turns the line run back into the line written. a site in a file not brought in: plain text
//
//   const code = createCode(el)
//   code.open("host.ts", 157)
//   code.live("the counter runner", fn)
//   siteHtml({ file, line, column })   // a link, or plain text
import type { FileLocation } from "@ermine/core/util/stacktrace"
// @ts-ignore: vite's ?raw, a file as text
import hostText from "./host.ts?raw"
// @ts-ignore: vite's ?raw
import thingsText from "./things.ts?raw"
// @ts-ignore: vite's ?raw
import terminalText from "./terminal.ts?raw"
// @ts-ignore: vite's ?raw
import mainText from "./main.ts?raw"

// the files brought in, by name
export const SOURCES: Record<string, string> = {
	"host.ts": hostText as string,
	"things.ts": thingsText as string,
	"main.ts": mainText as string,
	"terminal.ts": terminalText as string,
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

// ---- a site's file: one of ours, by its served path ----
function ourName(file: string): string | undefined {
	let path: string
	try {
		path = new URL(file, location.href).pathname
	} catch {
		return undefined
	}
	const name = path.split("/").pop() ?? ""
	if (!(name in SOURCES)) return undefined
	return path === `/dens/${name}` || path.endsWith(`/demos/dens/${name}`) ? name : undefined
}

// ---- source maps: the served module's line back to the written one ----
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
// a generated line's segments: [column, source line] (both from 0), by column
type Lines = [number, number][][]
function decode(mappings: string): Lines {
	const out: Lines = []
	let src = 0, line = 0, col = 0
	for (const row of mappings.split(";")) {
		const segs: [number, number][] = []
		let gen = 0
		for (const seg of row.split(",")) {
			if (!seg) continue
			const v: number[] = []
			let shift = 0, value = 0
			for (const ch of seg) {
				const d = B64.indexOf(ch)
				value += (d & 31) << shift
				if (d & 32) shift += 5
				else {
					v.push(value & 1 ? -(value >>> 1) : value >>> 1)
					value = shift = 0
				}
			}
			gen += v[0]
			if (v.length >= 4) {
				src += v[1], line += v[2], col += v[3]
				segs.push([gen, line])
			}
		}
		out.push(segs)
	}
	void src, col
	return out
}
const maps = new Map<string, Lines | null>()
const waiting = new Set<() => void>()
async function load(name: string) {
	if (maps.has(name)) return
	maps.set(name, null)
	try {
		const text = await (await fetch(new URL(`./${name}`, import.meta.url))).text()
		const m =
			/\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/
				.exec(text)
		if (!m) return
		const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))
		const map = JSON.parse(new TextDecoder().decode(bytes))
		maps.set(name, decode(String(map.mappings)))
		for (const f of waiting) f()
	} catch { /* no map (a build): the line as run */ }
}
for (const name of Object.keys(SOURCES)) load(name)
// told once each map is read (a site drawn before it can be drawn again, its line now right)
export const onMaps = (f: () => void) => void waiting.add(f)

// the line written, from the line and column run (both from 1); no map: the line as run
function written(name: string, line: number, column = 1): number {
	const lines = maps.get(name)
	const segs = lines?.[line - 1]
	if (!segs?.length) return line
	let best = segs[0]
	for (const s of segs) if (s[0] <= column - 1) best = s
	return best[1] + 1
}

// a site in words, and where it goes: one of ours, at the line written; else none
export function siteOf(at: FileLocation): { name?: string; line: number; text: string } {
	const name = ourName(at.file)
	if (name === undefined) {
		const file = at.file.split(/[/\\]/).pop()!.replace(/\?.*$/, "")
		return { line: at.line, text: `${file}:${at.line}` }
	}
	const line = written(name, at.line, at.column)
	return { name, line, text: `${name}:${line}` }
}
// a link that opens a file brought in at a line
export const codeLink = (name: string, line: number, label: string) =>
	`<button class="site" data-code="${esc(name)}" data-line="${line}" title="open ${
		esc(name)
	}:${line}">${esc(label)}</button>`
// a site as html: a link to it, or plain text
export function siteHtml(at: FileLocation | undefined, label?: string): string {
	if (!at) return esc(label ?? "—")
	const s = siteOf(at)
	const text = label ?? `${at.function ? `${at.function} · ` : ""}${s.text}`
	return s.name
		? codeLink(s.name, s.line, text)
		: `<code class="site-plain" title="${esc(at.file)}">${esc(text)}</code>`
}
// where a function is written, in a file brought in: its name's const or function line
export function origin(fn: unknown): { name: string; line: number } | undefined {
	if (typeof fn !== "function" || !fn.name) return undefined
	const re = new RegExp(`^(?:export )?(?:const|function|let)\\s+${fn.name}\\b`, "m")
	for (const [name, text] of Object.entries(SOURCES)) {
		const m = re.exec(text)
		if (m) return { name, line: text.slice(0, m.index).split("\n").length }
	}
	return undefined
}

// ---- the lines, numbered ----
export function linesHtml(text: string, lit?: number): string {
	return text.split("\n").map((l, i) =>
		`<div class="ln${i + 1 === lit ? " lit" : ""}" data-n="${i + 1}"><span class="n">${
			i + 1
		}</span><span class="t">${esc(l) || " "}</span></div>`
	).join("")
}

// ---- the code window ----
export function createCode(root: HTMLElement, show: () => void) {
	const tabs = root.querySelector<HTMLElement>(".code-tabs")!
	const body = root.querySelector<HTMLElement>(".code-body")!
	const note = root.querySelector<HTMLElement>(".code-note")!
	let shown: { name: string; text: string; live?: boolean } = {
		name: "host.ts",
		text: SOURCES["host.ts"],
	}
	let livePart: { name: string; text: string } | undefined

	function draw(lit?: number) {
		const names = Object.keys(SOURCES)
		tabs.innerHTML =
			names.map((n) =>
				`<button data-file="${esc(n)}" aria-pressed="${!shown.live && shown.name === n}">${
					esc(n)
				}</button>`
			).join("") + (livePart
				? `<button data-live aria-pressed="${!!shown.live}" title="${
					esc(livePart.name)
				}">live</button>`
				: "")
		body.innerHTML = linesHtml(shown.text, lit)
		note.textContent = shown.live
			? `${livePart?.name}: its code as it runs now (fn.toString(): types taken out by the server)`
			: `${shown.name}: this page's own source`
		const at = lit === undefined ? undefined : body.querySelector<HTMLElement>(".ln.lit")
		if (at) body.scrollTop = at.offsetTop - body.clientHeight / 2 + at.offsetHeight / 2
		else body.scrollTop = 0
	}
	tabs.addEventListener("click", (e) => {
		const b = (e.target as Element).closest<HTMLElement>("button")
		if (!b) return
		if (b.dataset.file) shown = { name: b.dataset.file, text: SOURCES[b.dataset.file] }
		else if (livePart) shown = { ...livePart, live: true }
		draw()
	})
	draw()
	return {
		// a file brought in, at a line, the line lit
		open(name: string, line?: number) {
			if (!(name in SOURCES)) return
			show()
			shown = { name, text: SOURCES[name] }
			draw(line)
		},
		// a live function's code, as it runs
		live(name: string, fn: unknown) {
			show()
			livePart = { name, text: String(fn) }
			shown = { ...livePart, live: true }
			draw()
		},
	}
}
