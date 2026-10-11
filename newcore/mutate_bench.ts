// deno bench newcore/mutate_bench.ts
// mutate against a fork of cabbages (mutate/cabbages.ts): the same patches, the same result
// mutate: what is touched copied, the old content kept, all or nothing
// cabbages: in place; "cabbages, cloned": a structuredClone first, so the old content is kept
import { assertEquals } from "@std/assert"
import { apply } from "./mutate/cabbages.ts"
import createChange, { type Change } from "./change.ts"
import createNode from "./node.ts"
import mutate from "./mutate.ts"
import { squish } from "./squish.ts"
import type { Patch } from "./notify.ts"

const N = 10_000
const rnd = (() => {
	let x = 1
	return (n: number) => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n
})()
const by = { actor: "me", time: 1 }
const host = createChange("a", { time: 0, actor: "host" })

type Work = { start: () => unknown; patches: Patch[] }

// one character at a time, at a caret
const typing: Patch[] = Array.from(
	{ length: N },
	(_, i) => ({ path: ["t"], range: [i, i], value: "a" }),
)
// typing, every fifth a backspace
const fixing: Patch[] = []
for (let i = 0, caret = 0; i < N; i++) {
	if (i % 5 === 4) fixing.push({ path: ["t"], range: [caret - 1, caret] }), caret--
	else fixing.push({ path: ["t"], range: [caret, caret], value: "a" }), caret++
}
const work: Record<string, Work> = {
	typing: { start: () => ({ t: "" }), patches: typing },
	"typing, squished": { start: () => ({ t: "" }), patches: squish(typing) },
	fixing: { start: () => ({ t: "" }), patches: fixing },
	// a list grown at the end
	appending: {
		start: () => ({ l: [] }),
		patches: Array.from({ length: N }, (_, i) => ({ path: ["l"], range: [i, i], value: [i] })),
	},
	// bytes grown at the end
	bytes: {
		start: () => ({ b: new Uint8Array() }),
		patches: Array.from(
			{ length: N },
			(_, i) => ({ path: ["b"], range: [i, i], value: new Uint8Array([i & 255]) }),
		),
	},
	// inserts at random places in 100 strings of 1000
	scattered: {
		start: () => ({
			docs: Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => [`d${i}`, "x".repeat(1000)]),
			),
		}),
		patches: Array.from({ length: N }, () => {
			const at = rnd(1000)
			return { path: ["docs", `d${rnd(100)}`], range: [at, at], value: "y" }
		}),
	},
	// puts to fields of 10 rows of 100 fields
	puts: {
		start: () => ({
			rows: Array.from(
				{ length: 10 },
				() => Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, 0])),
			),
		}),
		patches: Array.from(
			{ length: N },
			(_, i) => ({ path: ["rows", rnd(10), `f${rnd(100)}`], value: i }),
		),
	},
	// one element of 1000 moved to another place
	moves: {
		start: () => ({ l: Array.from({ length: 1000 }, (_, i) => i) }),
		patches: Array.from({ length: N }, () => {
			const at = rnd(1000)
			return { path: ["l"], range: [at, at], move: { path: ["l", rnd(1000)] } }
		}),
	},
}

const node = (content: unknown) =>
	createNode<unknown, Change>("a", { value: [{ content, change: host }] })
const viaMutate = (w: Work) => {
	const n = node(w.start())
	mutate(n, "value", w.patches, by)
	return n.value[0].content
}
const viaCabbages = (w: Work) => {
	let root = w.start()
	for (const p of w.patches) root = apply(root, p)
	return root
}

// the same end, before anything is timed
for (const [name, w] of Object.entries(work)) {
	assertEquals(viaMutate(w), viaCabbages(w), name)
}

for (const [name, w] of Object.entries(work)) {
	Deno.bench(`${name}: mutate`, { group: name, baseline: true }, (b) => {
		const n = node(w.start())
		b.start()
		mutate(n, "value", w.patches, by)
		b.end()
	})
	Deno.bench(`${name}: cabbages`, { group: name }, (b) => {
		let root = w.start()
		b.start()
		for (const p of w.patches) root = apply(root, p)
		b.end()
	})
	Deno.bench(`${name}: cabbages, cloned`, { group: name }, (b) => {
		const old = w.start()
		b.start()
		let root = structuredClone(old)
		for (const p of w.patches) root = apply(root, p)
		b.end()
	})
}

// each patch its own change: an editor's keystrokes. 1000 here: mutate copies what it touches
// each time, so a list grown this way costs its length squared
const M = 1000
const each: Record<string, Work> = {
	"typing, a change each": { start: work.typing.start, patches: typing.slice(0, M) },
	"appending, a change each": {
		start: work.appending.start,
		patches: work.appending.patches.slice(0, M),
	},
	"puts, a change each": { start: work.puts.start, patches: work.puts.patches.slice(0, M) },
}
for (const [name, w] of Object.entries(each)) {
	Deno.bench(`${name}: mutate`, { group: name, baseline: true }, (b) => {
		const n = node(w.start())
		b.start()
		for (const p of w.patches) mutate(n, "value", [p], by)
		b.end()
	})
	Deno.bench(`${name}: cabbages`, { group: name }, (b) => {
		let root = w.start()
		b.start()
		for (const p of w.patches) root = apply(root, p)
		b.end()
	})
}

// patched given: the facts notify reads gathered per patch
for (const name of ["typing", "appending", "puts", "moves"]) {
	const w = work[name]
	Deno.bench(`${name}: mutate, patched`, { group: `${name}, patched` }, (b) => {
		const n = node(w.start())
		b.start()
		mutate(n, "value", w.patches, { ...by, patched: () => {} })
		b.end()
	})
}

// strings: positions as code points (walked) against UTF-16 units (JavaScript's own)
// ASCII: the same patches either way. emoji typing: each count its own positions
const emoji = (step: number): Patch[] =>
	Array.from({ length: N }, (_, i) => ({ path: ["t"], range: [i * step, i * step], value: "😀" }))
const strings: Record<string, [Work, Work]> = {
	typing: [work.typing, work.typing],
	fixing: [work.fixing, work.fixing],
	scattered: [work.scattered, work.scattered],
	"typing emoji": [{ start: () => ({ t: "" }), patches: emoji(1) }, {
		start: () => ({ t: "" }),
		patches: emoji(2),
	}],
}
for (const [name, [points, units]] of Object.entries(strings)) {
	assertEquals(
		viaMutate(points),
		(() => {
			const n = node(units.start())
			mutate(n, "value", units.patches, { ...by, utf16: true })
			return n.value[0].content
		})(),
		name,
	)
	const group = `${name}: code points or utf16`
	const runs: [string, Work, boolean][] = [["code points", points, false], ["utf16", units, true]]
	for (const [count, w, utf16] of runs) {
		Deno.bench(`${name}: mutate, ${count}`, { group, baseline: !utf16 }, (b) => {
			const n = node(w.start())
			b.start()
			mutate(n, "value", w.patches, { ...by, utf16 })
			b.end()
		})
		Deno.bench(`${name}: mutate, patched, ${count}`, { group }, (b) => {
			const n = node(w.start())
			b.start()
			mutate(n, "value", w.patches, { ...by, utf16, patched: () => {} })
			b.end()
		})
		Deno.bench(`${name}: cabbages, ${count}`, { group }, (b) => {
			let root = w.start()
			b.start()
			for (const p of w.patches) root = apply(root, p, utf16)
			b.end()
		})
	}
}
