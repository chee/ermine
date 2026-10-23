import { assert, assertEquals } from "@std/assert"
import { MISNAMED, ORPHAN } from "./holder.ts"
import { createMemory } from "./memory.ts"
import { name, type Write } from "./write.ts"

// writes on one node: each on top of the one before
function series(node: string, n: number): Write[] {
	const out: Write[] = []
	for (let i = 0; i < n; i++) {
		out.push(name({
			node,
			part: "value",
			parents: i ? [out[i - 1].name] : [],
			patches: [{ path: [], value: i }],
			change: { time: i, actor: "A" },
		}))
	}
	return out
}

Deno.test("put: taken, then passed; since gives what is new after a cursor, at most limit", async () => {
	const m = createMemory()
	const ws = series("N", 3)
	assertEquals(await m.put(ws), ["taken", "taken", "taken"])
	assertEquals(await m.put([ws[1]]), ["passed"])
	const all = await m.since!()
	assertEquals(all.writes, ws)
	assertEquals(all.more, false)
	const first = await m.since!(undefined, 2)
	assertEquals(first.writes, ws.slice(0, 2))
	assert(first.more)
	const rest = await m.since!(first.cursor)
	assertEquals(rest.writes, ws.slice(2))
	assertEquals((await m.since!(rest.cursor)).writes, [])
})

Deno.test("refused: misnamed, missing parents, the holder's own say; refused writes are not held", async () => {
	const m = createMemory({ refuse: (w) => w.node === "secret" ? "not-here" : undefined })
	const [a, b] = series("N", 2)
	assertEquals(await m.put([b]), [{ refused: ORPHAN }])
	assertEquals(await m.put([{ ...a, node: "M" }]), [{ refused: MISNAMED }])
	assertEquals(await m.put(series("secret", 1)), [{ refused: "not-here" }])
	assertEquals(await m.put([a, b]), ["taken", "taken"])
	assertEquals(m.writes(), [a, b])
})

Deno.test("drop lets go of one node; a cursor stays good across it", async () => {
	const m = createMemory()
	const ns = series("N", 2), ms = series("M", 2)
	await m.put([ns[0], ms[0], ns[1]])
	const { cursor } = await m.since!(undefined, 2)
	await m.drop("N")
	assertEquals(await m.get!("N"), [])
	assertEquals(m.writes(), [ms[0]])
	await m.put([ms[1]])
	assertEquals((await m.since!(cursor)).writes, [ms[1]])
})

Deno.test("watch: poked when something is taken, not when all passed or refused; stop", async () => {
	const m = createMemory()
	let pokes = 0
	const stop = m.watch(() => pokes++)
	const ws = series("N", 2)
	await m.put([ws[0]])
	await m.put([ws[0]])
	await m.put([{ ...ws[1], name: "x" }])
	assertEquals(pokes, 1)
	stop()
	await m.put([ws[1]])
	assertEquals(pokes, 1)
})

Deno.test("a holder that can't list has no since; get still answers", async () => {
	const m = createMemory({ lists: false })
	assertEquals(m.since, undefined)
	const ws = series("N", 1)
	await m.put(ws)
	assertEquals(await m.get!("N"), ws)
})
