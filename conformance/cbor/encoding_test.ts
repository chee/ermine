// The old suite's value tests (conformance/scenarios/graph/values-*.json and
// decided-numbers-negative-zero.json, as old.json; the steps that are the graph's,
// not the encoding's, left out): each a value in its JSON form
// and what it reads back as, or refused. Run through a pack harness: the value is one node's,
// encoded and decoded. PACK_HARNESS: the C harness (default: the reference). Both are run.
// The old suite wrote a typed array as its bytes in base64; ENCODING.tex now writes its elements
// as a list, so those vectors fail by design. And the old graph held a live
// stand-in as a whole value, in memory, never encoded; pack encodes, and a live value has none.
// No uint8 kind: old.json's and lists.json's uint8 vectors are made
// int8 (one of old.json's, two forms in one map, uint16), or refused
import { assertEquals } from "@std/assert"
import { line } from "../pack/form.ts"

const TYPED = /"(u?int(8|16|32|64)|float(32|64))":/
const expected = (v: Vector) =>
	old.includes(v) &&
	(TYPED.test(line(v.value)) || TYPED.test(line(v.back)) || line(v.value).includes('"live":'))

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}../pack/harness.ts`.split(" ")
const other = Deno.env.get("PACK_HARNESS")?.split(" ")

type Vector = { from: string; value: unknown; back?: unknown; refused?: true }
const read = async (f: string): Promise<Vector[]> =>
	JSON.parse(await Deno.readTextFile(`${here}../../ermine/encoding/conformance/cbor/${f}`))
// lists.json: old.json's typed arrays made again as lists of their elements, all to agree
const old = await read("old.json"), lists = await read("lists.json")
const vectors = [...old, ...lists]

async function ask(command: string[], requests: object[]): Promise<Record<string, unknown>[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		signal: AbortSignal.timeout(30_000),
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => line(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	return new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
}

// a map's keys in any order are the same map; -0 is not 0
const stable = (x: unknown) =>
	line(
		x,
		(v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as never)[k]]))
				: v,
	)

const node = (value: unknown) => ({ value, change: { time: 0 } })

// each vector: what went wrong, or nothing
async function run(command: string[]): Promise<[Vector, string][]> {
	const encoded = await ask(command, vectors.map((v) => ({ op: "encode", node: node(v.value) })))
	const bytes = encoded.filter((a) => a.bytes).map((a) => ({ op: "decode", bytes: a.bytes }))
	const decoded = await ask(command, bytes)
	const wrong: [Vector, string][] = []
	let k = 0
	vectors.forEach((v, i) => {
		const e = encoded[i]
		if (e.error) return wrong.push([v, `${v.from}: ${e.error}`])
		if (v.refused) {
			if (e.bytes) {
				wrong.push([v, `${v.from}: taken, should be refused: ${line(v.value).slice(0, 100)}`])
			}
			if (e.bytes) k++
			return
		}
		if (!e.bytes) {
			return wrong.push([v, `${v.from}: refused (${e.code}): ${line(v.value).slice(0, 100)}`])
		}
		const got = (decoded[k++].node as { value: unknown }).value
		if (stable(got) !== stable(v.back)) {
			const was = line(v.back).slice(0, 100)
			wrong.push([v, `${v.from}: reads back ${line(got).slice(0, 100)}, the old suite ${was}`])
		}
	})
	return wrong
}

const harnesses: [string, string[]][] = [["reference", reference]]
if (other) harnesses.push(["PACK_HARNESS", other])
for (const [name, command] of harnesses) {
	Deno.test(`encoding: the old suite's ${vectors.length} value vectors, ${name}`, async () => {
		const wrong = await run(command)
		const other = wrong.filter(([v]) => !expected(v)).map(([, w]) => w)
		console.log(
			`${name}: ${vectors.length - wrong.length} of ${vectors.length} agree; ` +
				`${wrong.length - other.length} differ by design (typed arrays' form, live)`,
		)
		for (const w of other) console.log(`  ${w}`)
		assertEquals(other, [])
	})
}
