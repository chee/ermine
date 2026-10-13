// Runs the scenarios and the fuzzer against a harness. SCHEDULER_HARNESS: the command for another
// implementation (default: the reference). The protocol: harness.ts. A step's expect is its
// answer, exactly; fails: an error; neither: no error.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const scenarios = `${here}../../core/scheduler/conformance/scheduler`
const command = (Deno.env.get("SCHEDULER_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(
	" ",
)

// deno-lint-ignore no-explicit-any
type Request = { op: string; [k: string]: any }
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>
type Step = Request & { expect?: Answer; fails?: boolean }

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
	return new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "").map((l) =>
		JSON.parse(l)
	)
}

const files = [...Deno.readDirSync(scenarios)].map((f) => f.name).filter((n) => n.endsWith(".json"))
	.sort()
for (const name of files) {
	const { title, steps } = JSON.parse(Deno.readTextFileSync(`${scenarios}/${name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, fails: __, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, fails: __, ...r } = s
			const at = `step ${i}: ${JSON.stringify(r)}`
			if (s.fails) return assert(answers[i].error !== undefined, `${at}: no error`)
			if (s.expect !== undefined) return assertEquals(answers[i], s.expect, at)
			assertEquals(answers[i].error, undefined, at)
		})
	})
}

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const [a, b] = await ask([{ op: "nope" }, { op: "tick" }])
	assert(a.error)
	assertEquals(b, { tick: 0 })
})

// the fuzzer: computes summing, choosing and failing over the host's keys and each other's, and
// effects logging, under a few owners; the host writes and disposes, a pulse after each. against
// a plain model: everything evaluated again from scratch. a few dozen seeds (fuzz runs small)
const SEEDS = 40
const STEPS = 12
const HOST = ["h0", "h1", "h2", "h3"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// the model's evaluator: the fuzzer's forms only
type Expr = unknown
const num = (v: unknown) => (v === null || v === undefined ? 0 : v as number)
function evaluate(e: Expr, store: Map<string, unknown>): unknown {
	if (e === null || typeof e !== "object") return e
	if (Array.isArray(e)) return e.map((x) => evaluate(x, store))
	const [form, arg] = Object.entries(e as Record<string, unknown>)[0]
	const a = arg as Expr[]
	switch (form) {
		case "read":
			return store.get(arg as string) ?? null
		case "sum":
			return a.reduce((n: number, x) => n + num(evaluate(x, store)), 0)
		case "mod":
			return num(evaluate(a[0], store)) % num(evaluate(a[1], store))
		case "eq":
			return JSON.stringify(evaluate(a[0], store)) === JSON.stringify(evaluate(a[1], store))
		case "if":
			return evaluate(a[0], store) === true ? evaluate(a[1], store) : evaluate(a[2], store)
		case "throw":
			throw new Error(arg as string)
	}
	throw new Error(`no form ${form}`)
}

type Made = {
	name: string
	kind: "compute" | "effect"
	owner: string
	f: Expr
	alive: boolean
	acted?: { value: unknown }
	last?: { value: unknown }
}
type Check = { at: number; check: (a: Answer, label: string) => void }

function generate(seed: number) {
	const pick = rand(seed)
	const one = <T>(xs: T[]) => xs[pick(xs.length)]
	const requests: Request[] = []
	const checks: Check[] = []
	const store = new Map<string, unknown>()
	const owners = new Map<string, { parent?: string; alive: boolean }>()
	const made: Made[] = []
	const send = (r: Request, check?: Check["check"]) => {
		if (check) checks.push({ at: requests.length, check })
		requests.push(r)
	}

	for (let i = 0; i < 3; i++) {
		const parent = i === 0 || pick(2) === 0 ? undefined : `o${pick(i)}`
		owners.set(`o${i}`, { parent, alive: true })
		send(
			parent === undefined
				? { op: "owner", name: `o${i}` }
				: { op: "owner", name: `o${i}`, parent },
		)
	}
	const values: Record<string, number> = {}
	for (const h of HOST) values[h] = pick(6)
	for (const [k, v] of Object.entries(values)) store.set(k, v)
	send({ op: "write", values })

	const reads = (keys: string[], n: number) =>
		Array.from({ length: n }, () => ({ read: one(keys) }))
	const keys = [...HOST]
	const computes = 3 + pick(5)
	for (let i = 0; i < computes; i++) {
		const k = pick(10)
		let f: Expr
		if (k < 5) f = { sum: reads(keys, 1 + pick(3)) }
		else if (k < 7) f = { mod: [{ sum: reads(keys, 1 + pick(2)) }, 3] }
		else if (k < 9) {
			f = {
				if: [
					{ eq: [{ mod: [{ read: one(keys) }, 2] }, 0] },
					{ read: one(keys) },
					{ sum: [{ read: one(keys) }, 1] },
				],
			}
		} else {f = {
				if: [{ eq: [{ read: one(HOST) }, 5] }, { throw: "five" }, { sum: reads(keys, 2) }],
			}}
		const name = `c${i}`
		const owner = `o${pick(3)}`
		made.push({ name, kind: "compute", owner, f, alive: true })
		send({ op: "compute", name, owner, f, to: name })
		keys.push(name)
	}
	const effects = 2 + pick(3)
	for (let i = 0; i < effects; i++) {
		const name = `e${i}`
		const owner = `o${pick(3)}`
		const f = { sum: reads(keys, 1 + pick(2)) }
		made.push({ name, kind: "effect", owner, f, alive: true })
		send({ op: "effect", name, owner, f, act: { log: [name, { given: "value" }] } })
	}

	const under = (m: Made, o: string) => {
		for (let x: string | undefined = m.owner; x !== undefined; x = owners.get(x)!.parent) {
			if (x === o) return true
		}
		return false
	}

	// after a pulse: computes again from scratch, in the order made (each reads earlier keys)
	const pulse = (label: string) => {
		send({ op: "pulse" })
		const acts: unknown[][] = []
		for (const m of made) {
			if (!m.alive) continue
			let v: unknown
			try {
				v = evaluate(m.f, store)
			} catch {
				continue
			}
			if (m.kind === "compute") {
				if (m.last === undefined || m.last.value !== v) {
					m.last = { value: v }
					store.set(m.name, v)
				}
			} else if (m.acted === undefined || m.acted.value !== v) {
				m.acted = { value: v }
				acts.push([m.name, v])
			}
		}
		const living = new Set(made.filter((m) => m.alive).map((m) => m.name))
		send({ op: "moments" }, (a, at) => {
			const seen = new Set<string>()
			let acting = false
			for (const m of a.moments) {
				if (m.acts !== undefined) {
					acting = true
					assert(!seen.has(m.acts), `${at} ${label}: ${m.acts} acted twice`)
					assert(living.has(m.acts), `${at} ${label}: ${m.acts} acted, disposed`)
					seen.add(m.acts)
				}
				if (m.starts !== undefined) {
					assert(!acting, `${at} ${label}: ${m.starts} ran after an act`)
				}
			}
		})
		const want = acts.map((x) => JSON.stringify(x)).sort()
		send({ op: "log" }, (a, at) => {
			const got = (a.log as unknown[]).map((x) => JSON.stringify(x)).sort()
			assertEquals(got, want, `${at} ${label}: acts`)
		})
		for (const m of made) {
			if (m.kind !== "compute") continue
			const v = store.get(m.name) ?? null
			send(
				{ op: "get", key: m.name },
				(a, at) => assertEquals(a, { value: v }, `${at} ${label}: ${m.name}`),
			)
		}
	}

	pulse("first pulse")
	for (let step = 0; step < STEPS; step++) {
		const k = pick(10)
		if (k < 7) {
			const w: Record<string, number> = {}
			for (let i = 1 + pick(2); i > 0; i--) w[one(HOST)] = pick(6)
			for (const [key, v] of Object.entries(w)) store.set(key, v)
			send({ op: "write", values: w })
		} else if (k < 9) {
			const alive = made.filter((m) => m.alive)
			if (alive.length) {
				const m = one(alive)
				m.alive = false
				send({ op: "dispose", owner: m.name })
			}
		} else {
			const o = `o${1 + pick(2)}`
			if (owners.get(o)!.alive) {
				for (const [n, x] of owners) {
					let y: string | undefined = n
					while (y !== undefined && y !== o) y = owners.get(y)!.parent
					if (y === o) x.alive = false
				}
				for (const m of made) if (under(m, o)) m.alive = false
				send({ op: "dispose", owner: o })
			}
		}
		pulse(`step ${step}`)
	}
	return { requests, checks }
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} steps against the model`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { requests, checks } = generate(seed)
		const answers = await ask(requests)
		assertEquals(answers.length, requests.length, `seed ${seed}: one answer per request`)
		answers.forEach((a, i) => assertEquals(a.error, undefined, `seed ${seed}, request ${i}`))
		for (const c of checks) c.check(answers[c.at], `seed ${seed}, request ${c.at}`)
	}
})
