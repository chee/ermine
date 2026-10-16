// shot.ts: a picture of ermine-pigs' screen. deno run -A shot.ts <screen.ans> <out.png> [ROWSxCOLS]
// the bytes ermine-pigs draws (its --dump, or what a pty read from it) played onto a grid (the
// escapes it writes: cursor moves, SGR colours, clear), the grid as HTML (a ▀ cell as its two
// colours exactly), and headless Chrome's screenshot of it
const [input, out, size = ""] = Deno.args
const bytes = await Deno.readFile(input)
const text = new TextDecoder().decode(bytes)
let [rows, cols] = size.split("x").map(Number)
// no size given: as far as the cursor went
if (!rows || !cols) {
	rows = 1, cols = 1
	for (const m of text.matchAll(/\x1b\[(\d+);(\d+)H/g)) {
		rows = Math.max(rows, +m[1]), cols = Math.max(cols, +m[2] + 40)
	}
}
type Cell = { ch: string; fg: string; bg: string; bold: boolean }
const blank = (): Cell => ({ ch: " ", fg: "#000", bg: "#000", bold: false })
let grid: Cell[][] = []
const clear = () => (grid = Array.from({ length: rows }, () => Array.from({ length: cols }, blank)))
clear()
let r = 0, c = 0, fg = "#000", bg = "#000", bold = false
const cube = (n: number) => {
	if (n >= 232) {
		const v = 8 + 10 * (n - 232)
		return `rgb(${v},${v},${v})`
	}
	const l = [0, 95, 135, 175, 215, 255], i = n - 16
	return `rgb(${l[Math.floor(i / 36)]},${l[Math.floor(i / 6) % 6]},${l[i % 6]})`
}
for (let i = 0; i < text.length;) {
	if (text[i] === "\x1b" && text[i + 1] === "[") {
		const m = /^\x1b\[([?0-9;]*)([A-Za-z])/.exec(text.slice(i, i + 64))
		if (!m) {
			i++
			continue
		}
		i += m[0].length
		const ps = m[1].split(";").map(Number)
		if (m[2] === "H") r = (ps[0] || 1) - 1, c = (ps[1] || 1) - 1
		else if (m[2] === "J") clear()
		else if (m[2] === "m") {
			for (let k = 0; k < ps.length; k++) {
				const p = ps[k]
				if (p === 0) bold = false
				else if (p === 1) bold = true
				else if ((p === 38 || p === 48) && ps[k + 1] === 2) {
					const v = `rgb(${ps[k + 2]},${ps[k + 3]},${ps[k + 4]})`
					p === 38 ? (fg = v) : (bg = v)
					k += 4
				} else if ((p === 38 || p === 48) && ps[k + 1] === 5) {
					p === 38 ? (fg = cube(ps[k + 2])) : (bg = cube(ps[k + 2]))
					k += 2
				}
			}
		}
		continue
	}
	const ch = String.fromCodePoint(text.codePointAt(i)!)
	i += ch.length
	if (ch === "\r" || ch === "\n") continue
	if (r < rows && c < cols) grid[r][c] = { ch, fg, bg, bold }
	c++
}
// PIGS_TEXT=1: the grid's characters printed too
if (Deno.env.get("PIGS_TEXT")) {
	for (const row of grid) {
		console.log(row.map((k) => k.ch).join(""))
	}
}
const W = 9, H = 18
let html = `<html><body style="margin:0;background:#000"><div style="position:relative;width:${
	cols * W
}px;height:${rows * H}px;font:15px/18px Menlo,monospace">`
for (let y = 0; y < rows; y++) {
	for (let x = 0; x < cols; x++) {
		const k = grid[y][x]
		const back = k.ch === "▀" ? `linear-gradient(${k.fg} 50%, ${k.bg} 50%)` : k.bg
		const ch = k.ch === "▀" || k.ch === " " ? "" : k.ch.replace("&", "&amp;").replace("<", "&lt;")
		html +=
			`<div style="position:absolute;left:${x * W}px;top:${
				y * H
			}px;width:${W}px;height:${H}px;` +
			`background:${back};color:${k.fg};${
				k.bold ? "font-weight:bold;" : ""
			}overflow:visible;white-space:pre">${ch}</div>`
	}
}
html += "</div></body></html>"
const page = await Deno.makeTempFile({ suffix: ".html" })
await Deno.writeTextFile(page, html)
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
await new Deno.Command(chrome, {
	args: [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		`--screenshot=${out}`,
		`--window-size=${cols * W},${rows * H}`,
		`file://${page}`,
	],
	stdout: "null",
	stderr: "null",
}).output()
await Deno.remove(page)
console.log(out)
