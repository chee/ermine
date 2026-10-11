// deno bench newcore/protect/ts/protect_bench.ts
// one ask against rules: by list length and where the match is; what an actor costs; check along
// a route; the ask builders. baselines: anyone, and facts alone
import {
	anyone,
	type Args,
	check,
	facts,
	first,
	pass,
	placing,
	type Read,
	read,
	rules,
} from "./protect.ts"

const at = (values: Record<string, unknown>): Read => (id) =>
	Object.hasOwn(values, id) ? { value: values[id] } : undefined

const args: Args = { node: "n", object: ["info", "tags"], at: 0 }
const actor = {
	actor: "bob",
	peer: "k1",
	code: [{ process: "p1" }, { process: "p2", program: { node: "prog", time: 3 } }],
}

// n rules none of which match, then one that does: the whole list is walked
const missing = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ actor: `other${i}`, op: "write", allow: false }))
const list = (n: number) => [...missing(n - 1), { actor: "bob", op: "write", allow: true }]

Deno.bench("anyone", { group: "one ask", baseline: true }, () => {
	anyone("bob", "write", args, at({}))
})
for (const n of [1, 10, 100, 1000]) {
	const r = at({ r: list(n) })
	const may = rules("r")
	Deno.bench(`rules: ${n}, match last`, { group: "one ask" }, () => {
		may("bob", "write", args, r)
	})
}
{
	const r = at({ r: [{ actor: "bob", allow: true }, ...missing(999)] })
	const may = rules("r")
	Deno.bench("rules: 1000, match first", { group: "one ask" }, () => {
		may("bob", "write", args, r)
	})
}
{
	const r = at({})
	const may = rules("r")
	Deno.bench("rules: not loaded", { group: "one ask" }, () => {
		may("bob", "write", args, r)
	})
}

Deno.bench("facts: a string actor", { group: "actor", baseline: true }, () => {
	facts("bob", "write", args)
})
Deno.bench("facts: the scheduler's actor", { group: "actor" }, () => {
	facts(actor, "write", args)
})
{
	const r = at({ r: list(10) })
	const may = rules("r")
	Deno.bench("rules: 10, the scheduler's actor", { group: "actor" }, () => {
		may(actor, "write", args, r)
	})
	const deep = at({
		r: [
			...Array.from(
				{ length: 9 },
				(_, i) => ({ actor: { ...actor, peer: `k${i + 2}` }, allow: false }),
			),
			{ actor, allow: true },
		],
	})
	Deno.bench("rules: 10, whole actors compared deep", { group: "actor" }, () => {
		may({ ...actor, actor: undefined }, "write", args, deep)
	})
}

for (const depth of [1, 10, 100]) {
	const route = Array.from({ length: depth }, (_, i) => ({ node: `n${i}`, name: "x" }))
	const asks = pass(route)
	const r = at({ r: list(10) })
	const may = rules("r")
	Deno.bench(
		`check: route ${depth} deep, anyone`,
		{ group: `route ${depth}`, baseline: true },
		() => {
			check(anyone, "bob", asks, r)
		},
	)
	Deno.bench(`check: route ${depth} deep, rules 10`, { group: `route ${depth}` }, () => {
		check(may, "bob", asks, r)
	})
	Deno.bench(`check: route ${depth} deep, first(anyone, rules 10)`, {
		group: `route ${depth}`,
	}, () => {
		check(first(anyone, may), "bob", asks, r)
	})
	Deno.bench(`pass: build ${depth} asks`, { group: `route ${depth}` }, () => {
		pass(route)
	})
}

for (const n of [10, 1000]) {
	const before = Array.from({ length: n }, (_, i) => `id${i}`)
	const moved = [...before].reverse()
	const swapped = [...before.slice(1), "new"]
	Deno.bench(`placing: ${n}, reordered`, { group: `placing ${n}`, baseline: true }, () => {
		placing("n", "x", before, moved)
	})
	Deno.bench(`placing: ${n}, one out one in`, { group: `placing ${n}` }, () => {
		placing("n", "x", before, swapped)
	})
	Deno.bench(`placing: ${n}, all out`, { group: `placing ${n}` }, () => {
		placing("n", "x", before, [])
	})
}

{
	const names = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`k${i}`, []]))
	const small = { id: "n", value: [{}], info: names(2), children: names(2) }
	const big = { id: "n", value: [{}], info: names(20), children: names(200) }
	Deno.bench("read: 2 info, 2 lists", { group: "read", baseline: true }, () => {
		read(small)
	})
	Deno.bench("read: 20 info, 200 lists", { group: "read" }, () => {
		read(big)
	})
}
