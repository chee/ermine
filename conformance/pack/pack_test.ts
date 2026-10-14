// Runs the scenarios (ermine/encoding/conformance/pack) against a pack harness. PACK_HARNESS: the
// command for another implementation (default: the reference). The encoding is canonical, so bytes
// are compared: each set of entries packs to the reference's bytes, which unpack as expected; each
// node read back encodes alone to the reference's bytes, which decode back as it.
// A scenario: {title, entries, nodes, expect?}: expect {bytes?, entries?, nodes?}, what unpack
// gives (none: the entries and nodes as given), or {code, part?, id?}, pack refused; or {title,
// bytes, node?, expect: {code} or {entries, nodes}}, read by unpack, or by decode with "node":
// true. options: pack's and encode's ({op: false}); reading: unpack's and decode's ({loosyGoosy:
// true}). part and id are compared only where the scenario names them
import { assertEquals } from "@std/assert"
import { ask } from "./ask.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`.split(" ")
const subject = (Deno.env.get("PACK_HARNESS") ?? reference.join(" ")).split(" ")
const dir = `${here}../../ermine/encoding/conformance/pack`

type Node = { value?: unknown; change: Record<string, unknown> }
type Shown = { entries: unknown[][]; nodes: Node[] }
type Request = Record<string, unknown> & { op: string }
type Answer = Partial<Shown> & {
	node?: Node
	bytes?: string
	code?: string
	part?: string
	id?: string
	error?: string
}
type Expect = Partial<Shown> & {
	bytes?: string
	node?: Node
	code?: string
	part?: string
	id?: string
}
type Scenario = Partial<Shown> & {
	title: string
	bytes?: string
	node?: boolean
	options?: Record<string, unknown>
	reading?: Record<string, unknown>
	expect?: Expect
}

// a refusal, with part and id where the scenario names them
function refused(a: Answer, e: Expect) {
	const got: Expect = { code: a.code }
	if (e.part !== undefined) got.part = a.part
	if (e.id !== undefined) got.id = a.id
	return got
}
const want = (e: Expect) => {
	const out: Expect = { code: e.code }
	if (e.part !== undefined) out.part = e.part
	if (e.id !== undefined) out.id = e.id
	return out
}

for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) as Scenario
	Deno.test(`${f.name}: ${s.title}`, async () => {
		if (s.bytes !== undefined) {
			const [a] = await ask(subject, [{
				op: s.node ? "decode" : "unpack",
				bytes: s.bytes,
				reading: s.reading,
			}])
			if (s.expect?.code !== undefined) return assertEquals(refused(a, s.expect), want(s.expect))
			if (s.node) return assertEquals(a.node, s.expect!.node)
			assertEquals({ entries: a.entries, nodes: a.nodes }, {
				entries: s.expect!.entries,
				nodes: s.expect!.nodes,
			})
			return
		}
		const given = { op: "pack", entries: s.entries, nodes: s.nodes, options: s.options }
		const [ours] = await ask(subject, [given])
		if (s.expect?.code !== undefined) return assertEquals(refused(ours, s.expect), want(s.expect))
		const [theirs] = await ask(reference, [given])
		assertEquals(ours.bytes, theirs.bytes, "pack: the reference's bytes")
		if (s.expect?.bytes !== undefined) assertEquals(ours.bytes, s.expect.bytes, "pack: the bytes")
		const expected: Shown = {
			entries: s.expect?.entries ?? s.entries!,
			nodes: s.expect?.nodes ?? s.nodes!,
		}
		const [back] = await ask(subject, [{ op: "unpack", bytes: theirs.bytes, reading: s.reading }])
		assertEquals({ entries: back.entries, nodes: back.nodes }, expected, "unpack")
		// each node alone: the reference's bytes, read back as it
		const asks = expected.nodes.map((node) => ({ op: "encode", node, options: s.options }))
		const [one, two] = await Promise.all([ask(subject, asks), ask(reference, asks)])
		assertEquals(one, two, "encode: the reference's bytes")
		const nodes = await ask(subject, two.map((a) => ({ op: "decode", bytes: a.bytes })))
		assertEquals(nodes.map((a) => a.node), expected.nodes, "decode")
	})
}
