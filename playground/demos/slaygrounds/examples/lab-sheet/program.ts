/** @jsxImportSource ermine-h */
import { createAction, createMemo, ensureNode, patch, PENDING, read } from "@ermine/system"
import { bind, handler } from "ermine-h"

// program.ts: a spreadsheet. ./cells/A1 holds the text typed; calc:A1 is a memo that reads it, and
// the memo of each cell it names (a pending memo makes its reader pending: read throws PENDING). so editing a cell reruns that cell's calc, and a
// calc whose answer changed reruns the ones that read it, each once. a cell is two bound things:
// its answer, bound to calc:A1, and under it an input bound to cells/A1, shown while
// you type. a cell flashes when its answer changed: type a number into A1 and watch only A3, B2,
// B3, C3 flash.
// =SLOW(x, ms) answers late: the memo is pending and everything that reads it waits, then lands. a loop (A1 =A2, A2 =A1) is cut by the scheduler: the cells keep
// their last values
const LOOK = `
body { background: #ffff88; margin: 8px; font-family: Jost, system-ui, sans-serif }
.lab { display: flex; flex-direction: column; gap: 8px; width: 584px }
.card { background: #fff; border: 1px solid #000; box-shadow: 0 0 10px 2px #66003322; border-radius: 6px; padding: 6px }
table { border-collapse: collapse; width: 100%; table-layout: fixed }
th { background: #ffff88; font-weight: 600; border: 1px solid #000; padding: 0 4px }
th:first-child { width: 22px }
td { border: 1px solid #000; padding: 0; height: 24px; position: relative; cursor: text }
td > span { position: absolute; inset: 0 }
.show { display: block; height: 100%; padding: 0 5px; line-height: 24px; text-align: right; overflow: hidden;
	white-space: nowrap; text-overflow: ellipsis; box-sizing: border-box }
.show.text { text-align: left }
.show.error { background: #ffd9ea; color: #ff2284 }
td > span[data-ermine-waiting] { background: repeating-linear-gradient(45deg, #fff, #fff 6px, #c8f6ea 6px, #c8f6ea 12px) }
td > span[data-ermine-waiting] .show { visibility: hidden }
td > span[data-ermine-waiting]::after { content: "…"; position: absolute; right: 5px; line-height: 24px }
td input { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; font: inherit; padding: 0 5px;
	background: #fff; box-sizing: border-box; display: none; outline: 2px solid #2269ff; outline-offset: -2px }
td input.on { display: block }
td.flash { animation: flash 700ms ease-out }
@keyframes flash { from { background: #ff2284 } to { background: transparent } }
.hint { font-size: 12px }
code { background: #ffff88; padding: 0 3px }
`
const COLS = "ABCDEF".split("")
const ROWS = 8
const names = COLS.flatMap((c) => Array.from({ length: ROWS }, (_, r) => `${c}${r + 1}`))
const SEED: Record<string, string> = {
	A1: "3",
	A2: "4",
	A3: "=A1*A2",
	B1: "10",
	B2: "=A3+B1",
	B3: "=SUM(A1:B2)",
	C1: "=SLOW(B3*2, 1500)",
	C2: "=C1+1",
	C3: '=IF(B3>40, "big", "small")',
	D1: "=AVG(A1:B3)",
}

const span = (a: string, b: string) => {
	const [c0, r0] = [COLS.indexOf(a[0]), +a.slice(1)]
	const [c1, r1] = [COLS.indexOf(b[0]), +b.slice(1)]
	const out: string[] = []
	for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
		for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) out.push(`${COLS[c]}${r}`)
	}
	return out
}

class Bad extends Error {}
type Formula = (
	R: (n: string) => unknown,
	G: (a: string, b: string) => unknown[],
	slow: (x: unknown, ms?: number) => unknown,
) => unknown
const compiled = new Map<string, Formula>()
function compile(src: string): Formula {
	let f = compiled.get(src)
	if (f) return f
	const body = src.slice(1)
		.replace(
			/\b([A-F])([0-9]{1,2})\s*:\s*([A-F])([0-9]{1,2})\b/gi,
			(_, a, b, c, d) => `G("${a.toUpperCase()}${b}","${c.toUpperCase()}${d}")`,
		)
		.replace(/\b([A-F])([0-9]{1,2})\b(?!")/g, (_, a, b) => `R("${a}${b}")`)
		.replace(/\b(SUM|AVG|MIN|MAX|COUNT|IF|SLOW)\s*\(/gi, (_, n) => `F.${n.toUpperCase()}(`)
	if (/[^\w\s"().,+\-*/<>=!&|?:%]/.test(body)) throw new Bad("odd characters")
	f = new Function(
		"R",
		"G",
		"SLOW",
		`
		const flat = (xs) => xs.flat(Infinity).filter((x) => typeof x === "number")
		const F = {
			SUM: (...xs) => flat(xs).reduce((a, b) => a + b, 0),
			AVG: (...xs) => { const f = flat(xs); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0 },
			MIN: (...xs) => Math.min(...flat(xs)),
			MAX: (...xs) => Math.max(...flat(xs)),
			COUNT: (...xs) => flat(xs).length,
			IF: (c, a, b) => (c ? a : b),
			SLOW,
		}
		return (${body})`,
	) as Formula
	compiled.set(src, f)
	return f
}

export default function program() {
	const src: Record<string, ReturnType<typeof ensureNode>> = {}
	for (const n of names) src[n] = ensureNode("./cells/" + n, SEED[n] ?? "")
	createAction(
		"on/edit",
		(ref: string, text: string) => patch(src[ref], [{ path: [], value: text }]),
	)

	// ---- the calc of each cell: a memo, so its answer is a node and its pending is a status ----
	const ran: Record<string, number> = {}
	for (const ref of names) {
		createMemo("calc:" + ref, () => {
			ran[ref] = (ran[ref] ?? 0) + 1
			const text = String(read(src[ref]) ?? "")
			if (!text.startsWith("=")) {
				const n = Number(text)
				return text.trim() === "" ? null : Number.isFinite(n) ? n : text
			}
			// a pending calc throws PENDING through the formula: this one is pending too
			const R = (name: string) => {
				const v = read("calc:" + name)
				if (v !== null && typeof v === "object" && "error" in v) throw new Bad("from " + name)
				return v ?? 0
			}
			const G = (a: string, b: string) => span(a, b).map(R)
			let slow: Promise<unknown> | undefined
			const SLOW = (x: unknown, ms = 1200) => {
				slow = new Promise((r) => setTimeout(r, Number(ms)))
				return x
			}
			let out
			try {
				out = compile(text)(R, G, SLOW)
			} catch (e) {
				if (e === PENDING) return PENDING
				if (e instanceof Bad) return { error: e.message }
				return { error: "bad formula" }
			}
			if (typeof out === "number" && !Number.isFinite(out)) return { error: "÷0" }
			if (slow) return slow.then(() => out)
			return out
		})
	}

	// ---- the grid: per cell, its answer (bound to its calc) and an input (bound to its text) ----
	// the answer as the calc has it: a number, a text, or why not
	const answer = (ref: string) => (v: unknown) => {
		const error = v !== null && typeof v === "object" ? String((v as any).error ?? "err") : ""
		return (
			<span
				class={error ? "show error" : typeof v === "string" ? "show text" : "show"}
				title={`${ref}: calc ran ${ran[ref] ?? 0}×`}
			>
				{error ? "#" + error : v === null ? "" : String(v)}
			</span>
		)
	}
	// a cell: its answer, and its input in front of it only while typing (a click on the cell shows
	// it; "on" is the program's own class, so a reload leaves it as it is). the input's value is the
	// text node's: typing changes only the input until it is committed (Enter, or leaving the cell),
	// and the node then holds what the input has: nothing is put back
	const cell = (ref: string) => (
		<td
			onClick={(e: MouseEvent) => {
				const input = (e.currentTarget as HTMLElement).querySelector("input")!
				input.classList.add("on")
				input.focus()
			}}
		>
			{bind("calc:" + ref, answer(ref))}
			<input
				value={bind("cells/" + ref)}
				onChange={handler("on/edit", (e) => [ref, e.target.value])}
				onKeyDown={(e: KeyboardEvent) => {
					// a block, never cond && …: a listener returning false would cancel the key
					if (e.key === "Enter") (e.target as HTMLInputElement).blur()
				}}
				onBlur={(e: FocusEvent) => {
					;(e.target as HTMLElement).classList.remove("on")
				}}
			/>
		</td>
	)
	// a cell whose answer changed flashes: ermine-h tells it on the bound element ("ermine:change");
	// the table listens once (a reload takes the old listener away)
	const flashes = (table: HTMLElement) => {
		const was = (table as any).flash
		if (was) table.removeEventListener("ermine:change", was)
		;(table as any).flash = (e: Event) => {
			const td = (e.target as Element).closest("td")
			if (!td) return
			td.classList.remove("flash")
			void td.offsetWidth
			td.classList.add("flash")
		}
		table.addEventListener("ermine:change", (table as any).flash)
	}
	return (
		<div class="lab">
			<style>{LOOK}</style>
			<div class="card">
				<table ref={flashes}>
					<tr>
						<th></th>
						{COLS.map((c) => <th>{c}</th>)}
					</tr>
					{Array.from({ length: ROWS }, (_, i) => (
						<tr>
							<th>{i + 1}</th>
							{COLS.map((c) => cell(c + (i + 1)))}
						</tr>
					))}
				</table>
			</div>
			<div class="hint card">
				type into a cell (Enter): <code>=A1*A2</code> <code>=SUM(A1:B2)</code>{" "}
				<code>=IF(A1&gt;2,1,0)</code>{" "}
				<code>=SLOW(A1, 2000)</code>. a cell flashes when its answer changed: the calcs that
				reran with something new.
			</div>
		</div>
	)
}
