// a read's own depend (#1) against a fallback asking for the running reader each place (#3);
// depend only counts: tracking is the scheduler's
import createNode, { type Node } from "../nodes/node.ts"
import { createPlaces, type Depend } from "./places.ts"

// fixed counts: the first benches otherwise run during warmup
const bench = (name: string, o: Omit<Deno.BenchDefinition, "fn" | "name">, fn: () => void) =>
	Deno.bench(name, { n: 200_000, warmup: 50_000, ...o }, fn)

const depth = 8
const nodes = new Map<string, Node<unknown, unknown>>()
const change = {}
for (let i = 0; i < depth; i++) {
	const kids: [string, { content: string[]; change: object }[]][] = [
		[`n${i + 1}`, [{ content: [`gone${i}`, `n${i + 1}`], change }]],
	]
	if (i === 0) kids.push(["theme", [{ content: ["plum", "butter"], change }]])
	nodes.set(`n${i}`, createNode(`n${i}`, { children: kids }))
}
nodes.set(`n${depth}`, createNode(`n${depth}`))
nodes.set("plum", createNode("plum"))
nodes.set("butter", createNode("butter"))
const get = (id: string) => nodes.get(id)
const place = Array.from({ length: depth }, (_, i) => `n${i + 1}`)

let said = 0
const tracking: Depend = () => void said++

const plain = createPlaces(get, "n0")
// the scheduler sets this around each run
const running: Depend | undefined = tracking
const asking = createPlaces(get, "n0", { fallback: (id, part) => running?.(id, part) })

bench("none", { group: "lookup" }, () => void plain.lookup(place, ["theme"]))
bench(
	"#1 per read",
	{ group: "lookup", baseline: true },
	() => void plain.lookup(place, ["theme"], tracking),
)
bench("#3 fallback asks", { group: "lookup" }, () => void asking.lookup(place, ["theme"]))

bench("none", { group: "look" }, () => void plain.look(place, ["..", `n${depth}`]))
bench(
	"#1 per read",
	{ group: "look", baseline: true },
	() => void plain.look(place, ["..", `n${depth}`], tracking),
)
bench(
	"#3 fallback asks",
	{ group: "look" },
	() => void asking.look(place, ["..", `n${depth}`]),
)

// a chain depth deep; each list has width ids, the last the one that goes on, the rest
// split between not loaded and loaded without the next name; theme at the root only
function chain(depth: number, width: number) {
	const nodes = new Map<string, Node<unknown, unknown>>()
	const change = {}
	for (let i = 0; i < depth; i++) {
		const ids: string[] = []
		for (let j = 0; j < width - 1; j++) {
			const id = `x${i}.${j}`
			ids.push(id)
			if (j % 2) nodes.set(id, createNode(id))
		}
		ids.push(`n${i + 1}`)
		const kids: [string, { content: string[]; change: object }[]][] = [
			[`n${i + 1}`, [{ content: ids, change }]],
			["other", [{ content: ["plum"], change }]],
		]
		if (i === 0) kids.push(["theme", [{ content: ["plum", "butter"], change }]])
		nodes.set(`n${i}`, createNode(`n${i}`, { children: kids }))
	}
	nodes.set(
		`n${depth}`,
		createNode(`n${depth}`, { children: [["theme", [{ content: ["plum"], change }]]] }),
	)
	nodes.set("plum", createNode("plum"))
	nodes.set("butter", createNode("butter"))
	const places = createPlaces((id: string) => nodes.get(id), "n0")
	const place = Array.from({ length: depth }, (_, i) => `n${i + 1}`)
	return { places, place }
}

for (const depth of [1, 8, 64]) {
	const { places, place } = chain(depth, 1)
	const group = `depth ${depth}`
	bench("look .", { group, baseline: true }, () => void places.look(place, []))
	bench("look /", { group }, () => void places.look(place, ["/"]))
	bench("lookup near", { group }, () => void places.lookup(place, ["theme"]))
	bench("lookup far", { group }, () => void places.lookup(place, ["other"]))
	bench("lookup none", { group }, () => void places.lookup(place, ["nothing"]))
	bench("lookups", { group }, () => void places.lookups(place, ["other"]))
	bench("children", { group }, () => void places.children(place, [".."]))
	bench("children name", { group }, () => void places.children(place, [".."], "other"))
}

for (const width of [1, 4, 16, 64]) {
	const { places, place } = chain(8, width)
	bench(
		`width ${width}`,
		{ group: "look ., depth 8, by width", baseline: width === 1 },
		() => void places.look(place, []),
	)
}

// names walked from the root each read, against a trail made once by cd
for (const depth of [2, 8, 64]) {
	const { places, place } = chain(depth, 1)
	const here = places.cd(place)
	const group = `cd, depth ${depth}`
	bench("look: names", { group, baseline: true }, () => void places.look(place, ["theme"]))
	bench("look: trail", { group }, () => void here.look(["theme"]))
	bench("lookup: names", { group }, () => void places.lookup(place, ["other"]))
	bench("lookup: trail", { group }, () => void here.lookup(["other"]))
	bench("cd", { group }, () => void places.cd(place))
}
