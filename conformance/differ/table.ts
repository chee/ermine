// table's streams: random add, sub, get, ids, at, who and the three dels over a few parts, ids
// (symbols too) and nodes (table_harness_test.ts's mix, copied), with the events asked now and
// then, plain or with every part at the id as it was when told (at: true).
// wild: odd keys (NUL, lone surrogates, "__proto__", "", a symbol and a string of one name),
// and requests missing a field or with a key of the wrong kind
import { type Generator, picker, type Request } from "./kit.ts"

const PARTS: unknown[] = ["value", "children", "info", { symbol: "drag" }]
const IDS: unknown[] = ["a", "b", "c", "d", { symbol: "here" }]
const NODES = ["n1", "n2", "n3", "n4"]
const ODD: unknown[] = ["", "\u0000", "\uD800", "__proto__", { symbol: "a" }, "a\u0000"]

const generator: Generator = {
	streams(seed, o) {
		const { pick, one } = picker(seed)
		const parts = o.wild ? [...PARTS, ...ODD] : PARTS, ids = o.wild ? [...IDS, ...ODD] : IDS
		const out: Request[] = []
		for (let i = 0; i < 120; i++) {
			const part = one(parts), id = one(ids), node = one(NODES)
			const k = pick(23)
			if (k < 6) out.push({ op: "add", part, id, node })
			else if (k < 8) out.push({ op: "sub", part, id, node })
			else if (k < 10) out.push({ op: "get", part, id })
			else if (k < 12) out.push({ op: "ids", part, node })
			else if (k < 13) out.push({ op: "at", id })
			else if (k < 15) out.push({ op: "who", node })
			else if (k < 17) out.push({ op: "del", part, id })
			else if (k < 18) out.push({ op: "del", part, node })
			else if (k < 19) out.push({ op: "del", node })
			else if (k < 21) out.push({ op: "events", at: true })
			else out.push({ op: "events" })
			if (o.wild && pick(15) === 0) {
				out.push(
					one([
						{ op: "add", part: 1, id, node },
						{ op: "add", part, id },
						{ op: "get", part },
						{ op: "del" },
						{ op: "who", node: 3 },
						{ op: "add", part: { symbol: 1 }, id, node },
						{ op: "Add", part, id, node },
					]),
				)
			}
		}
		out.push({ op: "events", at: true })
		return [out]
	},
}
export default generator
