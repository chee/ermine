// Runs the scenarios, and a seeded fuzzer, against a harness. TRIE_HARNESS: the command for
// another implementation (default: the reference). The protocol: harness.ts.
//
// The fuzzer runs random operations, and checks every answer against a plain model here: every
// path made, by its JSON, with when it was made and its value.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const command = (Deno.env.get("TRIE_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../../core/places/conformance/trie`

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

async function ask(requests: Request[]): Promise<Answer[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
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

type Step = Request & { expect: Answer }

for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${scenarios}/${f.name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, ...r } = s
			assertEquals(answers[i], s.expect, `step ${i}: ${JSON.stringify(r)}`)
		})
	})
}

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask([
		{ op: "nope" },
		{ op: "make", path: "a" },
		{ op: "make", path: ["a", 1] },
		{ op: "at", path: [], from: 3 },
		{ op: "set", entry: "root", value: 4 },
		{ op: "each", entry: "root", stop: "x" },
		{ op: "make", path: ["a"], as: "a" },
		{ op: "path", entry: "a" },
	])
	assertEquals(answers.length, 8)
	for (let i = 0; i < 6; i++) {
		assert(typeof answers[i].error === "string")
		assert(answers[i].error !== "no-entry" && answers[i].error !== "dead")
	}
	assertEquals(answers[6], { name: "a" })
	assertEquals(answers[7], { path: ["a"] })
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 150
const NAMES = ["a", "b", "c", "", "/", "a/b", "é", "🦊", "__proto__", ".", "2", "10", "1"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

type Made = { path: string[]; at: number; value: string | undefined }
type Pair = [Request, Answer]

function sequence(seed: number): Pair[] {
	const pick = rand(seed)
	const model = new Map<string, Made>([["[]", { path: [], at: 0, value: undefined }]])
	let clock = 0
	const out: Pair[] = []
	const key = (p: readonly string[]) => JSON.stringify(p)
	const randomPath = () => Array.from({ length: pick(4) }, () => NAMES[pick(NAMES.length)])
	const known = () => [...model.values()].map((m) => m.path)
	const anyPath = () => pick(3) === 0 ? randomPath() : known()[pick(model.size)]
	const under = (p: readonly string[]) =>
		[...model.values()].filter((m) =>
			m.path.length >= p.length && p.every((n, i) => m.path[i] === n)
		)
	// depth first, kids in the order made: by the time each differing prefix was made
	const order = (a: Made, b: Made) => {
		for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
			if (a.path[i] !== b.path[i]) {
				return model.get(key(a.path.slice(0, i + 1)))!.at -
					model.get(key(b.path.slice(0, i + 1)))!.at
			}
		}
		return a.path.length - b.path.length
	}
	const last = (p: readonly string[]) => p.length ? p[p.length - 1] : ""
	// at, perhaps from a prefix that is there: the handle h is the entry at p
	const bind = (p: string[], h: string, make: boolean) => {
		const i = pick(p.length + 1)
		const from = p.slice(0, i)
		const rest = p.slice(i)
		const exists = model.has(key(p))
		if (i > 0 && model.has(key(from))) {
			out.push([{ op: "at", path: from, as: "f" }, { name: last(from) }])
			if (make || exists) {
				out.push([{ op: make ? "make" : "at", path: rest, from: "f", as: h }, {
					name: last(p),
				}])
			} else out.push([{ op: "at", path: rest, from: "f", as: h }, {}])
		} else if (make || exists) {
			out.push([{ op: make ? "make" : "at", path: p, as: h }, { name: last(p) }])
		} else out.push([{ op: "at", path: p, as: h }, {}])
	}
	const made = (p: string[]) => {
		for (let i = 0; i <= p.length; i++) {
			const q = p.slice(0, i)
			if (!model.has(key(q))) model.set(key(q), { path: q, at: ++clock, value: undefined })
		}
	}
	for (let step = 0; step < STEPS; step++) {
		const k = pick(12)
		const p = anyPath()
		const there = model.has(key(p))
		if (k <= 1) {
			bind(p, "h", true)
			made(p)
		} else if (k === 2) {
			bind(p, "h", false)
		} else if (k === 3 && there) {
			const v = pick(3) === 0 ? undefined : `v${pick(100)}`
			out.push([{ op: "at", path: p, as: "h" }, { name: last(p) }])
			out.push([{ op: "set", entry: "h", value: v }, {}])
			out.push([{ op: "get", entry: "h" }, v === undefined ? {} : { value: v }])
			model.get(key(p))!.value = v
		} else if (k === 4 && there) {
			out.push([{ op: "at", path: p, as: "h" }, { name: last(p) }])
			const kid = under(p).find((m) => m.path.length > p.length)
			if (kid) out.push([{ op: "at", path: kid.path, as: "d" }, { name: last(kid.path) }])
			out.push([{ op: "drop", entry: "h" }, {}])
			if (p.length === 0) {
				model.clear()
				model.set("[]", { path: [], at: 0, value: undefined })
				out.push([{ op: "path", entry: "h" }, { path: [] }])
			} else {
				for (const m of under(p)) model.delete(key(m.path))
				out.push([{ op: "path", entry: "h" }, { error: "dead" }])
			}
			if (kid && p.length > 0) out.push([{ op: "get", entry: "d" }, { error: "dead" }])
		} else if (k === 5 && there) {
			out.push([{ op: "at", path: p, as: "h" }, { name: last(p) }])
			out.push([{ op: "prune", entry: "h" }, {}])
			let q = p
			while (q.length > 0) {
				const m = model.get(key(q))!
				if (m.value !== undefined || under(q).length > 1) break
				model.delete(key(q))
				q = q.slice(0, -1)
			}
			out.push([{ op: "path", entry: "h" }, model.has(key(p)) ? { path: p } : { error: "dead" }])
		} else if (k === 6 && there) {
			const all = under(p).sort(order).map((m) => m.path)
			const stop = pick(3) === 0 ? 1 + pick(all.length + 1) : undefined
			out.push([{ op: "at", path: p, as: "h" }, { name: last(p) }])
			const r: Request = { op: "each", entry: "h" }
			if (stop !== undefined) r.stop = stop
			out.push([r, {
				paths: stop === undefined ? all : all.slice(0, stop),
				stopped: stop !== undefined && stop <= all.length,
			}])
		} else if (k === 7 && there) {
			out.push([{ op: "at", path: p, as: "h" }, { name: last(p) }])
			out.push([{ op: "path", entry: "h" }, { path: p }])
		} else if (k === 8 && there) {
			out.push([{ op: "at", path: p, as: "h" }, { name: last(p) }])
			if (p.length === 0) out.push([{ op: "parent", entry: "h", as: "u" }, {}])
			else {
				out.push([{ op: "parent", entry: "h", as: "u" }, { name: last(p.slice(0, -1)) }])
				out.push([{ op: "path", entry: "u" }, { path: p.slice(0, -1) }])
			}
		} else if (k === 9 && there) {
			out.push([{ op: "at", path: p, as: "a" }, { name: last(p) }])
			out.push([{ op: "at", path: p, as: "b" }, { name: last(p) }])
			out.push([{ op: "same", a: "a", b: "b" }, { same: true }])
			const other = anyPath()
			if (model.has(key(other))) {
				out.push([{ op: "at", path: other, as: "b" }, { name: last(other) }])
				out.push([{ op: "same", a: "a", b: "b" }, { same: key(p) === key(other) }])
			}
		}
		out.push([{ op: "size" }, { size: model.size }])
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds of ${STEPS} steps against a plain model`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const steps = sequence(seed)
		const answers = await ask(steps.map(([r]) => r))
		assertEquals(answers.length, steps.length, `seed ${seed}`)
		steps.forEach(([r, a], i) => {
			assertEquals(answers[i], a, `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
