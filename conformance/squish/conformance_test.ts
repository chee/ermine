// Runs the scenarios and the fuzzer against a harness. SQUISH_HARNESS: the command for another
// implementation (default: the reference). The protocol: harness.ts.
//
// The fuzzer applies patches (notify's apply.ts) to a content: what the squished patches make is
// what the originals make, and they are never more. With SQUISH_HARNESS set, the reference is run
// too and must give the same patches: how far squishing goes is part of the library.
import { assert, assertEquals } from "@std/assert"
import { apply, at, type V } from "../notify/apply.ts"
import type { Key, Patch } from "@ermine/scheduler/notify"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const command = (Deno.env.get("SQUISH_HARNESS") ?? reference).split(" ")

type Request = { op: string; patches?: unknown[]; columns?: unknown }
// deno-lint-ignore no-explicit-any
type Answer = { error?: string; patches?: any[]; columns?: any }

async function ask(requests: Request[], cmd = command): Promise<Answer[]> {
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
	return lines.map((l) => JSON.parse(l))
}

type Step = Request & { expect: Omit<Answer, "error"> }

for await (const f of Deno.readDir(`${here}../../core/op/conformance/squish`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(
		await Deno.readTextFile(`${here}../../core/op/conformance/squish/${f.name}`),
	) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `step ${i}`)
			assertEquals(answers[i], s.expect, `step ${i}: ${JSON.stringify(s)}`)
		})
	})
}

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const [a, b] = await ask([{ op: "nope" }, { op: "squish", patches: [] }])
	assert(a.error)
	assertEquals(b, { patches: [] })
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 60

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

const TEXT = ["a", "b", "é", "😀", "xy", "!", "\n", '"', "ü✓"]
const chars = (s: string) => Array.from(s).length

function start(pick: (n: number) => number): V {
	return {
		t: Array.from({ length: pick(8) }, () => TEXT[pick(TEXT.length)]).join(""),
		l: Array.from({ length: pick(8) }, () => pick(100)),
		m: { a: 1, b: [2], c: { d: "x" } },
		n: { x: { y: 1 } },
	}
}

// patches that are valid one after the other, made against the content as it goes; they bunch
// up on a caret so that typing, backspacing and the like happen
function patches(pick: (n: number) => number, content: V, count: number): Patch[] {
	const out: Patch[] = []
	let caret = pick(4)
	const seq = (path: string[]) => {
		const s = at(content, path) as string | unknown[]
		return { path, len: typeof s === "string" ? chars(s) : s.length, text: typeof s === "string" }
	}
	for (let i = 0; i < count; i++) {
		const k = pick(21)
		let p: Patch | null = null
		if (k < 11) {
			const s = seq(pick(3) === 0 ? ["l"] : ["t"])
			const where = pick(4) === 0 ? pick(s.len + 1) : Math.min(caret, s.len)
			const many = () => {
				const n = 1 + pick(3)
				return s.text
					? Array.from({ length: n }, () => TEXT[pick(TEXT.length)]).join("")
					: Array.from({ length: n }, () => pick(100))
			}
			const kind = pick(6)
			if (kind < 3) {
				const value = many()
				p = { path: s.path, range: [where, where], value }
				caret = where + (typeof value === "string" ? chars(value) : value.length)
			} else if (kind < 5 && s.len > 0) {
				// a backspace, or a forward delete
				const back = pick(2) === 0 && where > 0
				const a = back ? where - 1 : Math.min(where, s.len - 1)
				const b = Math.min(s.len, a + 1 + (pick(4) === 0 ? 1 : 0))
				p = { path: s.path, range: [a, b] }
				caret = a
			} else if (s.len > 0) {
				const a = Math.min(where, s.len - 1)
				const b = Math.min(s.len, a + 1 + pick(2))
				p = { path: s.path, range: [a, b], value: many() }
				caret = a
			}
		} else if (k < 13) {
			// a move inside a sequence: found again in what is left
			const s = seq(pick(2) === 0 ? ["l"] : ["t"])
			if (s.len > 1) {
				const a = pick(s.len), b = Math.min(s.len, a + 1 + pick(2))
				const g = pick(s.len - (b - a) + 1)
				p = { path: s.path, range: [g, g], move: { path: s.path, range: [a, b] } }
			}
		} else if (k < 15) {
			// a key moved to another
			const m = at(content, ["m"]) as Record<string, V>
			const keys = Object.keys(m)
			if (keys.length) {
				const from = keys[pick(keys.length)]
				p = { path: ["m", "k" + pick(3)], move: { path: ["m", from] } }
			}
		} else if (k < 18) {
			const m = at(content, ["m"]) as Record<string, V>
			const key = ["a", "b", "c", "k0", "k1"][pick(5)]
			p = pick(3) === 0 && key in m
				? { path: ["m", key] }
				: { path: ["m", key], value: pick(100) }
		} else if (k < 19) {
			const n = at(content, ["n"]) as Record<string, V>
			const x = n.x as Record<string, V> | undefined
			const j = pick(5)
			if (j === 0) p = { path: ["n"], value: pick(2) ? { x: { y: pick(9) } } : {} }
			else if (j === 1 && x) p = { path: ["n", "x"], value: pick(2) ? {} : { y: pick(9) } }
			else if (j === 2 && x) p = { path: ["n", "x", "y"], value: pick(9) }
			else if (j === 3 && x) p = { path: ["n", "x"] }
			else if (j === 4 && x && typeof x === "object") {
				p = { path: ["n", "x", "z"], value: pick(9) }
			}
		} else if (pick(3) === 0) {
			// the whole, same shape
			const c = start(pick) as Record<string, V>
			p = { path: [], value: c }
		}
		if (!p) continue
		content = apply(content, p)
		out.push(p)
	}
	return out
}

function applyAll(content: V, ps: Patch[]): V {
	for (const p of ps) content = apply(content, p)
	return content
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} patches, same end, never more, same as the reference`, async () => {
	const runs = Array.from({ length: SEEDS }, (_, i) => {
		const pick = rand(i + 1)
		const from = start(pick)
		return { from, ps: patches(pick, from, STEPS) }
	})
	const request = (op: string) => runs.map((r) => ({ op, patches: r.ps }))
	const squished = await ask(request("squish"))
	const other = command.join(" ") === reference
		? null
		: await ask(request("squish"), reference.split(" "))
	runs.forEach((r, i) => {
		const out = squished[i].patches!
		assertEquals(squished[i].error, undefined)
		assertEquals(applyAll(r.from, out), applyAll(r.from, r.ps), `seed ${i + 1}: same end`)
		assert(out.length <= r.ps.length, `seed ${i + 1}: never more`)
		if (other) assertEquals(out, other[i].patches, `seed ${i + 1}: as the reference`)
	})
	// squished patches are valid patches: squishing them again changes nothing about the end
	const again = await ask(squished.map((a) => ({ op: "squish", patches: a.patches })))
	runs.forEach((r, i) => {
		assertEquals(
			applyAll(r.from, again[i].patches!),
			applyAll(r.from, r.ps),
			`seed ${i + 1}: again`,
		)
	})
})

Deno.test(`fuzz: ${SEEDS} seeds, columns and back`, async () => {
	const runs = Array.from({ length: SEEDS }, (_, i) => {
		const pick = rand(i + 101)
		return patches(pick, start(pick), STEPS)
	})
	const encoded = await ask(runs.map((ps) => ({ op: "encode", patches: ps })))
	const decoded = await ask(encoded.map((a) => ({ op: "decode", columns: a.columns })))
	const other = command.join(" ") === reference
		? null
		: await ask(runs.map((ps) => ({ op: "encode", patches: ps })), reference.split(" "))
	runs.forEach((ps, i) => {
		const c = encoded[i].columns
		assertEquals(decoded[i].patches, ps, `seed ${i + 1}: back`)
		const total = (runs: number[]) =>
			runs.filter((_, j) => j % 2 === 1).reduce((a, b) => a + b, 0)
		assertEquals(total(c.path), ps.length, "a path per patch")
		assertEquals(total(c.shape), ps.length, "a shape per patch")
		const ranged = ps.filter((p) => p.range).length
		assertEquals([total(c.from), total(c.size)], [ranged, ranged], "a from and a size per range")
		assertEquals(c.value.length, ps.filter((p) => "value" in p).length)
		assertEquals(c.move.length, ps.filter((p) => p.move).length)
		const keys = c.paths.map((p: Key[]) => JSON.stringify(p))
		assertEquals(new Set(keys).size, keys.length, "each path once")
		if (other) assertEquals(c, other[i].columns, `seed ${i + 1}: as the reference`)
	})
})
