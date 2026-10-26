import { assert, assertEquals, assertThrows } from "@std/assert"
import { createErmine, ErmineError } from "./ermine.ts"
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	explainAttributes,
	explainChildren,
	getNode,
	hasNode,
	list,
	patch,
	patchAttributes,
	patchChildren,
	peep,
	read,
	readAllChildren,
	readAttributes,
	readChildren,
} from "@ermine/system"

Deno.test("@ermine/system: getNode makes nothing, ensureNode makes once, hasNode says which", () => {
	const e = createErmine({ schedule: () => {} })
	const seen: unknown[] = []
	e.open("/code/p", () => {
		const n = getNode("./nothing")
		seen.push(hasNode(n), hasNode("./nothing"))
		ensureNode("./made", { a: 1 })
		ensureNode("./made", { a: 2 })
		ensureNode("./empty")
		seen.push(hasNode("./made"), read("./made"), hasNode("./empty"), read("./empty"))
		seen.push(list("/code").sort())
	})
	e.start("/code/p")
	assertEquals(seen, [false, false, true, { a: 1 }, true, undefined, ["empty", "made", "p"]])
	e.close()
})

Deno.test("@ermine/system: patch takes patches only; a node not there: nothing-there; attributes by their own pair", () => {
	const e = createErmine({ schedule: () => {} })
	const errors: unknown[] = []
	e.open("/code/p", () => {
		ensureNode("./x", { n: 0 })
		patch("./x", [{ path: ["n"], value: 1 }])
		try {
			patch("./x", ((d: { n: number }) => void (d.n = 2)) as never)
		} catch (x) {
			errors.push((x as ErmineError).code)
		}
		try {
			patch("./missing", [{ path: [], value: 1 }])
		} catch (x) {
			errors.push((x as { code?: string }).code)
		}
		patchAttributes("./x", [{ path: ["kind"], value: "thing" }])
	})
	e.start("/code/p")
	assertEquals(e.read("/code/x"), { n: 1 })
	assertEquals(errors, ["not-patches", "nothing-there"])
	let kind: unknown
	e.getProcessContext()!.within(() => kind = readAttributes("/code/x", ["kind"]))
	assertEquals(kind, "thing")
	e.close()
})

Deno.test("@ermine/system: createMemo and createEffect, early by an option; nothing open: nothing-open", () => {
	const e = createErmine({ schedule: () => {} })
	const acted: [string, unknown][] = []
	e.open("/code/p", () => {
		ensureNode("./n", 2)
		const twice = createMemo("twice", () => (read("./n") as number) * 2)
		createEffect("show", () => read(twice), (v) => void acted.push(["late", v]))
		createEffect("first", () => read("./n"), (v) => void acted.push(["early", v]), {
			early: true,
		})
	})
	e.start("/code/p")
	e.pulse()
	assert(acted.some(([k, v]) => k === "early" && v === 2))
	assert(acted.some(([k, v]) => k === "late" && v === 4))
	assertThrows(() => read("/code/n"), ErmineError, "read: nothing is open")
	e.close()
})

Deno.test("@ermine/system: the three parts alike: readChildren (handles), patchChildren (a name a patch), explainChildren, readAllChildren (no ids), explainAttributes", () => {
	const e = createErmine({ schedule: () => {} })
	const seen: Record<string, unknown> = {}
	e.open("/code/p", () => {
		ensureNode("./box/a", 1)
		const b = ensureNode("./b", 2)
		const kids = readChildren("./box")
		seen.names = Object.keys(kids)
		seen.a = read(kids.a)
		patchChildren("./box", [{ path: ["also"], value: b }])
		seen.also = read("./box/also")
		patchChildren("./box", [{ path: ["a"] }])
		seen.after = list("./box").sort()
		try {
			patchChildren("./box", [{ path: [], value: {} }])
		} catch (x) {
			seen.whole = (x as ErmineError).code
		}
		seen.who = explainChildren("./box")?.writer?.kind
		patchAttributes("./b", [{ path: ["k"], value: 1 }])
		seen.attrs = explainAttributes("./b")?.writer?.kind
		seen.all = JSON.stringify(readAllChildren("./box").map((v) => Object.keys(v.value as object)))
	})
	e.start("/code/p")
	assertEquals(seen, {
		names: ["a"],
		a: 1,
		also: 2,
		after: ["also"],
		whole: "not-patches",
		who: "outside",
		attrs: "outside",
		all: '[["also"]]',
	})
	e.close()
})

Deno.test("@ermine/system: peep(f) reads untracked: a memo reading through peep isn't rerun by it", () => {
	const e = createErmine({ schedule: () => {} })
	let runs = 0
	e.open("/code/p", () => {
		ensureNode("./n", 1)
		createMemo("m", () => (runs++, peep(() => read("./n"))))
		createAction("on/bump", () => patch("./n", [{ path: [], value: 2 }]))
	})
	e.start("/code/p")
	e.pulse()
	const before = runs
	e.send("/code/p/on/bump")
	e.pulse()
	assertEquals(runs, before)
	e.close()
})

Deno.test("@ermine/system: a handle used with nothing open (a listener, a timer) acts as its maker; a path doesn't", async () => {
	const e = createErmine({ schedule: () => {} })
	let count: ReturnType<typeof ensureNode> | undefined
	let bump: ReturnType<typeof createAction> | undefined
	e.open("/code/p", () => {
		count = ensureNode("./count", 0)
		bump = createAction("on/bump", () => patch("./count", [{ path: [], value: 10 }]))
	})
	e.start("/code/p")
	// a timer: nothing open, as a DOM listener's click
	const outcome = await new Promise<unknown[]>((done) =>
		setTimeout(() => {
			const out: unknown[] = []
			patch(count!, [{ path: [], value: 1 }])
			out.push(read(count!))
			executeAction(bump!)
			out.push(read(count!))
			try {
				patch("/code/count", [{ path: [], value: 2 }])
			} catch (x) {
				out.push((x as ErmineError).code)
			}
			done(out)
		}, 0)
	)
	assertEquals(outcome, [1, 10, "nothing-open"])
	assertEquals(e.explain("/code/count")?.writer?.kind, "method")
	e.close()
})
