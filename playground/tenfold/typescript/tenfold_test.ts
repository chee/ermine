// tenfold on a den, drawn on a recording (no canvas): the letters' ops, a throw marked while the
// rest draw, a loop that never ends ended by the budget, a source or knob changed and drawn again,
// a compile per source (build's cache), a guest letter as a process on the engine's runner, and
// the engine stopped with what runs on it. the letters here are the tests' own, two to four cells
import { assert, assertEquals, assertInstanceOf } from "@std/assert"
import { STATUS } from "@ermine/places/status"
import { instrument } from "./budget.ts"
import { LETTER } from "./engine.ts"
import { BudgetError, createPen, load, type Op } from "./letter.ts"
import { createRecording } from "./surfaces.ts"
import { createTenfold, VIEW } from "./tenfold.ts"
import { KNOBS, LETTERS } from "./letters.ts"

const BAR = "move(-1, 0)\nline(1, 0)"
const DOT = "width(0.2)\ncircle(0, 0, 0.5)\nfill()"

function world(
	letters: Record<string, string>,
	cells: { letter: string; x?: number }[],
	o: { slow?: number } = {},
) {
	const rec = createRecording()
	const t = createTenfold({
		surface: rec.surface,
		letters,
		knobs: { cells, period: 1000, slow: o.slow ?? 1e9 },
		schedule: () => {},
	})
	const engine = t.start()
	// a frame at ms, then pulses enough for a compile to land and the cells to draw
	const frame = (ms: number) => {
		rec.frame(ms)
		for (let i = 0; i < 4; i++) t.pulse()
	}
	const settle = () => {
		for (let i = 0; i < 4; i++) t.pulse()
	}
	const cell = (i: number) => t.idAt([...VIEW, "cells", String(i)])
	const status = (i: number) => t.table.get("attributes", cell(i)!)?.value?.[STATUS]
	const value = (i: number) =>
		t.table.get("value", cell(i)!)?.value as { letter: string; cost: number }
	settle()
	return { ...t, rec, engine, frame, settle, cell, status, value }
}

Deno.test("the budget: each loop's condition checked, a for-of's iterable each item; strings, comments and regular expressions passed over", () => {
	assertEquals(instrument("while (true) x++"), "while (__tick() && (true)) x++")
	assertEquals(instrument("do { x++ } while (x < 3)"), "do { x++ } while (__tick() && (x < 3))")
	assertEquals(instrument("for (;;) {}"), "for (; __tick();) {}")
	assertEquals(
		instrument("for (let i = 0; i < 3; i++) {}"),
		"for (let i = 0;__tick() && ( i < 3); i++) {}",
	)
	assertEquals(instrument("for (const v of vs) {}"), "for (const v of __each(vs)) {}")
	assertEquals(instrument("for (k in o) { for (;;) {} }"), "for (k in o) { for (; __tick();) {} }")
	const passed = "const s = 'while (1)' // for (;;)\nconst r = /for\\(/g; a.while(1); `${b}while`"
	assertEquals(instrument(passed), passed)
})

Deno.test("a letter loaded: the pen's ops in clip space, what is left open stroked; a loop past its budget throws BudgetError", () => {
	const ops: Op[] = []
	const pen = createPen((op) => ops.push(op))
	const params = { q: 0, r: 0, x: 0.5, y: 0, t: 0, s: {} }
	pen.begin()
	load(instrument("shift(x, 0)\nmove(0, 0)\nline(0, 1)")).draw(pen.pen, params)
	pen.end()
	assertEquals(ops, [["move", 0.5, 0], ["line", 0.5, 1], ["stroke", 0.05]])
	let threw: unknown
	try {
		load(instrument("let n = 0\nwhile (true) n++")).draw(pen.pen, params)
	} catch (e) {
		threw = e
	}
	assertInstanceOf(threw, BudgetError)
})

Deno.test("letters drawn on the engine's cells: each cell its letter's ops, the cell's value its letter and cost, no status; every frame again", () => {
	const w = world({ "bar/0.js": BAR, "dot/0.js": DOT }, [{ letter: "bar/0.js" }, {
		letter: "dot/0.js",
	}])
	w.frame(0)
	assertEquals(w.rec.cells[0], [["move", -1, 0], ["line", 1, 0], ["stroke", 0.05]])
	assertEquals(w.rec.cells[1], [["move", 0.5, 0], ["arc", 0, 0, 0.5, 0, 1], ["fill"]])
	assertEquals([w.status(0), w.status(1)], [undefined, undefined])
	assertEquals(w.value(0).letter, "bar/0.js")
	assertEquals(typeof w.value(0).cost, "number")
	// the run, as an inspector reads it
	assertEquals(w.apis.runs(w.cell(0)!)?.end, "done")
	// t from the clock: a letter drawing it shows the frame
	w.write("bar/0.js", "move(t, 0)")
	w.frame(250)
	assertEquals(w.rec.cells[0], [["move", 0.25, 0], ["stroke", 0.05]])
	w.frame(500)
	assertEquals(w.rec.cells[0], [["move", 0.5, 0], ["stroke", 0.05]])
})

Deno.test("the folder's own letters spell ERMINE, each drawing, none marked", () => {
	const w = world(LETTERS, KNOBS.cells)
	w.frame(1234)
	for (let i = 0; i < KNOBS.cells.length; i++) {
		assert(w.rec.cells[i].length > 2, `cell ${i} drew`)
		assertEquals(w.rec.cells[i].filter((op) => op[0] === "mark"), [])
		assertEquals(w.status(i), undefined)
	}
})

Deno.test("a throwing letter: its cell marked with what it threw, its status the Error, its run failed; the others keep drawing", () => {
	const w = world(
		{ "bar/0.js": BAR, "boom/0.js": "move(0, 0)\nthrow new Error('boom')", "nope/0.js": "line(" },
		[{ letter: "bar/0.js" }, { letter: "boom/0.js" }, { letter: "nope/0.js" }, {
			letter: "gone/0.js",
		}],
	)
	w.frame(0)
	assertEquals(w.rec.cells[1], [["move", 0, 0], ["mark", "error", "boom"]])
	const st = w.status(1)
	assertInstanceOf(st, Error)
	assertEquals(st.message, "boom")
	const run = w.apis.runs(w.cell(1)!)
	assertEquals([run?.end, run?.error?.message], ["failed", "boom"])
	// a source that does not parse, a letter not there: thrown too
	assertEquals(w.rec.cells[2].map((op) => op[1]), ["error"])
	assertInstanceOf(w.status(2), SyntaxError)
	assertEquals(w.rec.cells[3], [["mark", "error", "no letter at gone/0.js"]])
	assertEquals(w.rec.cells[0], [["move", -1, 0], ["line", 1, 0], ["stroke", 0.05]])
	w.write("bar/0.js", "move(t, 0)")
	w.frame(500)
	assertEquals(w.rec.cells[0], [["move", 0.5, 0], ["stroke", 0.05]])
	assertEquals(w.rec.cells[1], [["move", 0, 0], ["mark", "error", "boom"]])
})

Deno.test("a loop that never ends, in a while, a for, a for-of: ended by the budget, the cell marked; the next frame drawn as well", () => {
	const forever = "function* g() { for (;;) yield 1 }\nlet n = 0\nfor (const v of g()) n += v"
	const w = world(
		{
			"bar/0.js": BAR,
			"w/0.js": "while (true) {}",
			"f/0.js": "for (let i = 0; i >= 0; i++) {}",
			"o/0.js": forever,
		},
		[{ letter: "bar/0.js" }, { letter: "w/0.js" }, { letter: "f/0.js" }, { letter: "o/0.js" }],
	)
	for (const ms of [0, 100]) {
		w.frame(ms)
		for (const i of [1, 2, 3]) {
			assertEquals(w.rec.cells[i], [["mark", "error", "loop budget (5000) spent"]])
			assertInstanceOf(w.status(i), BudgetError)
		}
		assertEquals(w.rec.cells[0].length, 3)
	}
})

Deno.test("a letter's source edited: drawn again with the new code at the next pulse, no frame needed; a knob changed: the same", () => {
	const w = world({ "bar/0.js": BAR, "dot/0.js": DOT }, [{ letter: "bar/0.js" }])
	w.frame(0)
	w.write("bar/0.js", "move(0, 0)\nline(0, 1)")
	w.settle()
	assertEquals(w.rec.cells[0], [["move", 0, 0], ["line", 0, 1], ["stroke", 0.05]])
	// a throw fixed: the mark gone, the status with it
	w.write("bar/0.js", "throw new Error('oops')")
	w.settle()
	assertInstanceOf(w.status(0), Error)
	w.write("bar/0.js", BAR)
	w.settle()
	assertEquals(w.rec.cells[0], [["move", -1, 0], ["line", 1, 0], ["stroke", 0.05]])
	assertEquals(w.status(0), undefined)
	// which version, and the params
	w.knob(0, { letter: "dot/0.js" })
	w.settle()
	assertEquals(w.rec.cells[0], [["move", 0.5, 0], ["arc", 0, 0, 0.5, 0, 1], ["fill"]])
	w.write("dot/0.js", "move(x, 0)")
	w.knob(0, { x: 0.75 })
	w.settle()
	assertEquals(w.rec.cells[0], [["move", 0.75, 0], ["stroke", 0.05]])
})

Deno.test("a compile a source: two cells on one letter, and frames, compile it once (build's cache); an edit compiles the new source; back again, a hit", () => {
	const w = world({ "bar/0.js": BAR }, [{ letter: "bar/0.js" }, { letter: "bar/0.js" }])
	for (const ms of [0, 16, 32]) w.frame(ms)
	assertEquals(w.compiles(), 1)
	w.write("bar/0.js", "move(0, 0)")
	w.settle()
	assertEquals(w.compiles(), 2)
	w.write("bar/0.js", BAR)
	w.settle()
	assertEquals(w.compiles(), 2)
	assertEquals(w.rec.cells[1], [["move", -1, 0], ["line", 1, 0], ["stroke", 0.05]])
})

Deno.test("a draw costing more than knobs.slow: marked cost over its ops", () => {
	const w = world({ "bar/0.js": BAR }, [{ letter: "bar/0.js" }], { slow: -1 })
	w.frame(0)
	const last = w.rec.cells[0].at(-1)!
	assertEquals([last[0], last[1]], ["mark", "cost"])
	assertEquals(w.status(0), undefined)
})

Deno.test("a guest: a letter started as a process on the engine's runner with args [cell] draws that cell while it runs; stopping the engine stops it, withdraws the runner, ends the frames", () => {
	const w = world({ "bar/0.js": BAR, "dot/0.js": DOT }, [{ letter: "bar/0.js" }, {
		letter: "dot/0.js",
	}])
	w.frame(0)
	const runner = [...VIEW, "runners", "letter"]
	assertEquals(w.table.get("attributes", w.idAt(runner)!)?.value?.["ermine.runner.takes"], LETTER)
	const code = instrument("move(0, 0)\nline(1, 1)")
	const guest = w.hosted(() =>
		w.den.start(runner, { id: "guest", code, type: LETTER }, ["tenfold", "guest"], { args: ["1"] })
	)
	assert(!("refused" in guest))
	w.settle()
	w.frame(16)
	assertEquals(w.rec.cells[1], [["move", 0, 0], ["line", 1, 1], ["stroke", 0.05]])
	assertEquals(w.value(1).letter, "guest/1")
	// a letter of the wrong form: refused
	const source = w.hosted(() => w.den.start(runner, ["tenfold", "letters", "bar", "0.js"], ["x"]))
	assertEquals("refused" in source && source.refused, "wrong-form")
	w.hosted(() => w.den.stop(guest))
	w.frame(32)
	assertEquals(w.rec.cells[1], [["move", 0.5, 0], ["arc", 0, 0, 0.5, 0, 1], ["fill"]])
	// again, and the engine stopped under it
	const again = w.hosted(() =>
		w.den.start(runner, { id: "guest", code, type: LETTER }, ["tenfold", "guest"], { args: ["1"] })
	)
	assert(!("refused" in again))
	w.settle()
	w.frame(48)
	assertEquals(w.value(1).letter, "guest/1")
	assertEquals(w.rec.listening(), 1)
	w.hosted(() => w.den.stop(w.engine, "bye"))
	assertEquals([w.den.find(again.id), w.den.find(w.engine.id)], [undefined, undefined])
	assertEquals(w.idAt(runner), undefined)
	assertEquals(w.idAt([...VIEW, "cells", "0"]), undefined)
	assertEquals(w.rec.listening(), 0)
	const before = w.rec.cells.map((ops) => [...ops])
	w.frame(64)
	w.write("bar/0.js", "move(0, 0)")
	w.settle()
	assertEquals(w.rec.cells, before)
})
